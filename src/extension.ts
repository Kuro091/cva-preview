import { randomBytes } from "node:crypto";
import path from "node:path";
import * as vscode from "vscode";
import { type CvaDefinition, findCvaDefinitions } from "./parse";
import type { FromWebview, ToWebview } from "./protocol";
import { buildPreviewCss, pickCssEntry } from "./tailwind";

const LANGUAGES = ["typescript", "typescriptreact", "javascript", "javascriptreact"];
const TYPING_PAUSE_MS = 200;

export function activate(context: vscode.ExtensionContext): void {
  const preview = new PreviewPanel(context.extensionUri);
  context.subscriptions.push(
    preview,
    vscode.languages.registerCodeLensProvider(
      LANGUAGES.map((language) => ({ language })),
      {
        provideCodeLenses: (document) =>
          definitionsOrNone(document.getText()).map(
            (definition) =>
              new vscode.CodeLens(new vscode.Range(definition.line - 1, 0, definition.line - 1, 0), {
                title: "Preview variants",
                command: "cvaPreview.show",
                arguments: [document.uri, definition.name],
              }),
          ),
      },
    ),
    vscode.commands.registerCommand("cvaPreview.show", (uri: vscode.Uri, name: string) => preview.show(uri, name)),
    vscode.commands.registerCommand("cvaPreview.showAtCursor", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      const definitions = definitionsOrNone(editor.document.getText());
      const cursorLine = editor.selection.active.line + 1;
      const atCursor = definitions.filter((definition) => definition.line <= cursorLine).at(-1) ?? definitions[0];
      if (!atCursor) {
        void vscode.window.showInformationMessage("This file has no cva definition.");
        return;
      }
      preview.show(editor.document.uri, atCursor.name);
    }),
    vscode.workspace.onDidChangeTextDocument(({ document }) => preview.onDocumentChanged(document)),
    vscode.workspace.onDidSaveTextDocument((document) => preview.onStylesheetSaved(document)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("cvaPreview")) {
        void preview.refresh();
      }
    }),
  );
}

function definitionsOrNone(source: string): CvaDefinition[] {
  try {
    return findCvaDefinitions(source);
  } catch {
    return [];
  }
}

class PreviewPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private uri: vscode.Uri | undefined;
  private selectedName = "";
  private selectedIndex = 0;
  private extraClasses = "";
  private stylesheets = new Set<string>();
  private typingTimer: NodeJS.Timeout | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  show(uri: vscode.Uri, name: string): void {
    this.uri = uri;
    this.selectedName = name;
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      void this.refresh();
      return;
    }
    const distUri = vscode.Uri.joinPath(this.extensionUri, "dist");
    this.panel = vscode.window.createWebviewPanel(
      "cvaPreview",
      name,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [distUri] },
    );
    this.panel.webview.html = this.html(this.panel.webview, distUri);
    this.panel.webview.onDidReceiveMessage((message: FromWebview) => this.receive(message));
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  onDocumentChanged(document: vscode.TextDocument): void {
    if (!this.panel || document.uri.toString() !== this.uri?.toString()) {
      return;
    }
    clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => void this.refresh(), TYPING_PAUSE_MS);
  }

  onStylesheetSaved(document: vscode.TextDocument): void {
    if (this.panel && this.stylesheets.has(document.uri.fsPath)) {
      void this.refresh();
    }
  }

  async refresh(): Promise<void> {
    if (!this.panel || !this.uri) {
      return;
    }
    const document = await vscode.workspace.openTextDocument(this.uri);
    let definitions: CvaDefinition[];
    try {
      definitions = findCvaDefinitions(document.getText());
    } catch {
      // Mid-edit syntax errors keep the last preview on screen.
      return;
    }
    const selected =
      definitions.find((definition) => definition.name === this.selectedName) ??
      definitions[Math.min(this.selectedIndex, definitions.length - 1)];
    this.select(selected?.name ?? "", definitions.indexOf(selected));

    const candidates = new Set(this.extraClasses.split(/\s+/));
    for (const definition of definitions) {
      const classLists = [
        definition.base,
        ...Object.values(definition.variants).flatMap((values) => Object.values(values)),
        ...definition.compoundVariants.map((compound) => compound.className),
      ];
      for (const candidate of classLists.join(" ").split(/\s+/)) {
        candidates.add(candidate);
      }
    }
    candidates.delete("");

    const message: ToWebview = {
      type: "update",
      fileName: path.basename(this.uri.fsPath),
      definitions,
      selected: this.selectedName,
      css: "",
      propertyCss: "",
    };
    try {
      const cssEntry = await this.cssEntry(this.uri);
      const built = await buildPreviewCss(cssEntry, [...candidates]);
      this.stylesheets = new Set(built.dependencies);
      message.css = built.css;
      message.propertyCss = built.propertyCss;
    } catch (error) {
      message.error = error instanceof Error ? error.message : String(error);
    }
    await this.panel?.webview.postMessage(message);
  }

  dispose(): void {
    clearTimeout(this.typingTimer);
    this.panel?.dispose();
  }

  private select(name: string, index: number): void {
    this.selectedName = name;
    this.selectedIndex = Math.max(index, 0);
    if (this.panel) {
      this.panel.title = name || "CVA Preview";
    }
  }

  private async cssEntry(uri: vscode.Uri): Promise<string> {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const configured = vscode.workspace.getConfiguration("cvaPreview", uri).get<string>("cssEntry");
    if (configured) {
      return folder ? path.resolve(folder.uri.fsPath, configured) : configured;
    }
    const pattern = folder ? new vscode.RelativePattern(folder, "**/*.css") : "**/*.css";
    const cssFiles = await vscode.workspace.findFiles(pattern, "**/{node_modules,dist,build,.git}/**");
    const entry = pickCssEntry(
      uri.fsPath,
      cssFiles.map((file) => file.fsPath),
    );
    if (!entry) {
      throw new Error('No stylesheet imports "tailwindcss". Set "cvaPreview.cssEntry" to your Tailwind entry file.');
    }
    return entry;
  }

  private receive(message: FromWebview): void {
    switch (message.type) {
      case "ready":
        void this.refresh();
        break;
      case "select":
        this.select(message.name, this.selectedIndex);
        break;
      case "extraClasses":
        this.extraClasses = message.classes;
        void this.refresh();
        break;
      case "copy":
        void vscode.env.clipboard.writeText(message.text);
        vscode.window.setStatusBarMessage(`Copied ${message.text}`, 3000);
        break;
    }
  }

  private html(webview: vscode.Webview, distUri: vscode.Uri): string {
    const nonce = randomBytes(16).toString("base64");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "webview.js"));
    const stylesheet = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "webview.css"));
    const codicons = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "codicon.css"));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} https: data:`,
      `img-src ${webview.cspSource} https: data:`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <link rel="stylesheet" href="${codicons}" id="vscode-codicon-stylesheet" />
    <link rel="stylesheet" href="${stylesheet}" />
  </head>
  <body>
    <main id="app"></main>
    <script nonce="${nonce}" src="${script}"></script>
  </body>
</html>`;
  }
}
