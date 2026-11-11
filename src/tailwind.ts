import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { FORCED_PSEUDO_CLASSES, forcedAttribute } from "./protocol";

type TailwindNode = typeof import("@tailwindcss/node");

const IMPORTS_TAILWIND = /@import\s+["']tailwindcss(\/[^"']*)?["']/;
// pnpm keeps @tailwindcss/node out of the top-level node_modules, so it is reached through the integration that depends on it.
const TAILWIND_INTEGRATIONS = ["@tailwindcss/vite", "@tailwindcss/postcss", "@tailwindcss/cli"];

export function pickCssEntry(sourceFile: string, cssFiles: string[]): string | undefined {
  const entries = cssFiles.filter((file) => IMPORTS_TAILWIND.test(readFileSync(file, "utf8")));
  return entries
    .map((file) => ({ file, shared: sharedSegments(path.dirname(file), sourceFile) }))
    .sort((a, b) => b.shared - a.shared || a.file.length - b.file.length)[0]?.file;
}

function sharedSegments(a: string, b: string): number {
  const left = a.split(path.sep);
  const right = b.split(path.sep);
  let count = 0;
  while (count < left.length && left[count] === right[count]) {
    count++;
  }
  return count;
}

export function loadTailwind(cssEntry: string): TailwindNode {
  for (let directory = path.dirname(cssEntry); ; directory = path.dirname(directory)) {
    if (existsSync(path.join(directory, "node_modules", "@tailwindcss", "node"))) {
      return createRequire(path.join(directory, "package.json"))("@tailwindcss/node");
    }
    for (const integration of TAILWIND_INTEGRATIONS) {
      const integrationDirectory = path.join(directory, "node_modules", integration);
      if (existsSync(integrationDirectory)) {
        return createRequire(path.join(realpathSync(integrationDirectory), "package.json"))("@tailwindcss/node");
      }
    }
    if (path.dirname(directory) === directory) {
      throw new Error(`Tailwind CSS 4 is not installed for ${cssEntry}. This preview needs @tailwindcss/node.`);
    }
  }
}

export interface PreviewCss {
  css: string;
  propertyCss: string;
  dependencies: string[];
}

export async function buildPreviewCss(cssEntry: string, candidates: string[]): Promise<PreviewCss> {
  const { compile } = loadTailwind(cssEntry);
  const forcedVariants = FORCED_PSEUDO_CLASSES.map(
    (pseudoClass) => `@custom-variant ${pseudoClass} (&:${pseudoClass}, &[${forcedAttribute(pseudoClass)}]);`,
  ).join("\n");
  const dependencies = [cssEntry];
  const compiler = await compile(`${readFileSync(cssEntry, "utf8")}\n${forcedVariants}\n`, {
    base: path.dirname(cssEntry),
    from: cssEntry,
    onDependency: (dependency) => dependencies.push(dependency),
  });
  const output = compiler.build(candidates);
  // @property rules are ignored inside a shadow root, so they are applied to the document instead.
  const propertyRules = output.match(/@property[^{]+\{[^}]*\}/g) ?? [];
  return { css: output, propertyCss: propertyRules.join("\n"), dependencies };
}
