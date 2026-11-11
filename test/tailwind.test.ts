import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPreviewCss, pickCssEntry } from "../src/tailwind";

const app = path.join(import.meta.dirname, "fixtures", "app");
const entry = path.join(app, "src", "styles.css");
const tokens = path.join(app, "src", "tokens.css");
const legacyEntry = path.join(app, "legacy", "styles.css");

describe("pickCssEntry", () => {
  it("picks the Tailwind entry closest to the source file", () => {
    const source = path.join(app, "src", "components", "button.ts");
    expect(pickCssEntry(source, [legacyEntry, tokens, entry])).toBe(entry);
    expect(pickCssEntry(path.join(app, "legacy", "chip.ts"), [legacyEntry, tokens, entry])).toBe(legacyEntry);
  });

  it("finds nothing when no stylesheet imports tailwindcss", () => {
    expect(pickCssEntry(path.join(app, "src", "button.ts"), [tokens])).toBeUndefined();
  });
});

describe("buildPreviewCss", () => {
  it("builds the candidates with the project's theme and forces hover and focus through data attributes", async () => {
    const { css, propertyCss, dependencies } = await buildPreviewCss(entry, [
      "bg-commit",
      "hover:bg-commit-hover",
      "has-focus-visible:outline-2",
      "shadow-sm",
    ]);
    expect(css).toContain("--color-commit: #15803d");
    expect(css).toMatch(/\.hover\\:bg-commit-hover:hover, \.hover\\:bg-commit-hover\[data-preview-hover\]/);
    expect(css).toContain(":has(:focus-visible, [data-preview-focus-visible])");
    expect(propertyCss).toMatch(/^@property --tw-shadow \{/);
    expect(dependencies).toEqual(expect.arrayContaining([entry, tokens]));
  });
});
