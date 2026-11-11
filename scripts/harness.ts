import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findCvaDefinitions } from "../src/parse";
import type { ToWebview } from "../src/protocol";
import { buildPreviewCss } from "../src/tailwind";

const [sourceFile, cssEntry, selected] = process.argv.slice(2);
if (!sourceFile || !cssEntry) {
  throw new Error("Usage: pnpm harness <source file> <tailwind entry css> [definition name]");
}

const definitions = findCvaDefinitions(readFileSync(sourceFile, "utf8"));
const candidates = definitions.flatMap((definition) =>
  [
    definition.base,
    ...Object.values(definition.variants).flatMap((values) => Object.values(values)),
    ...definition.compoundVariants.map((compound) => compound.className),
  ]
    .join(" ")
    .split(/\s+/),
);
const { css, propertyCss } = await buildPreviewCss(cssEntry, candidates);
const update: ToWebview = {
  type: "update",
  fileName: path.basename(sourceFile),
  definitions,
  selected: selected ?? definitions[0].name,
  css,
  propertyCss,
};

const dist = path.join(import.meta.dirname);
const output = path.join(dist, `harness-${path.basename(sourceFile)}.html`);
writeFileSync(
  output,
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <style>
      :root {
        --vscode-descriptionForeground: #9d9d9d; --vscode-dropdown-background: #313131; --vscode-dropdown-foreground: #cccccc;
        --vscode-dropdown-border: #3c3c3c; --vscode-input-background: #313131; --vscode-input-foreground: #cccccc;
        --vscode-focusBorder: #0078d4; --vscode-panel-border: #2b2b2b; --vscode-errorForeground: #f85149;
      }
      body { margin: 0; background: #1f1f1f; color: #cccccc; font: 13px system-ui, sans-serif; }
    </style>
    <style>${readFileSync(path.join(dist, "webview.css"), "utf8")}</style>
    <script>
      window.copied = [];
      window.acquireVsCodeApi = () => ({
        postMessage(message) {
          if (message.type === "ready") window.postMessage(${JSON.stringify(update)});
          if (message.type === "copy") window.copied.push(message.text);
        },
        getState: () => undefined,
        setState() {},
      });
    </script>
  </head>
  <body>
    <script src="webview.js"></script>
  </body>
</html>`,
);
console.log(output);
