import { copyFile, mkdir } from "node:fs/promises";
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const shared = { bundle: true, sourcemap: true, logLevel: "info" };

const contexts = await Promise.all([
  esbuild.context({
    ...shared,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
  }),
  esbuild.context({
    ...shared,
    entryPoints: ["src/webview.ts"],
    outfile: "dist/webview.js",
    platform: "browser",
    format: "iife",
    target: "chrome120",
  }),
]);

await mkdir("dist", { recursive: true });
await copyFile("src/webview.css", "dist/webview.css");
await copyFile("node_modules/@vscode/codicons/dist/codicon.css", "dist/codicon.css");
await copyFile("node_modules/@vscode/codicons/dist/codicon.ttf", "dist/codicon.ttf");

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
