import { describe, expect, it } from "vitest";
import { findCvaDefinitions } from "../src/parse";

describe("findCvaDefinitions", () => {
  it("reads base classes, variants and defaults of a literal definition", () => {
    const source = `
import { cva } from "class-variance-authority";

export const buttonVariants = cva(
  ["inline-flex rounded-md", \`text-sm\`],
  {
    variants: {
      variant: { primary: "bg-commit text-white", ghost: ["hover:bg-mute", null] },
      size: { md: "h-9.5 px-4", "icon-sm": "size-8" },
    },
    defaultVariants: { variant: "ghost", size: "md" },
  },
);`;
    expect(findCvaDefinitions(source)).toEqual([
      {
        name: "buttonVariants",
        line: 4,
        base: "inline-flex rounded-md text-sm",
        variants: {
          variant: { primary: "bg-commit text-white", ghost: "hover:bg-mute" },
          size: { md: "h-9.5 px-4", "icon-sm": "size-8" },
        },
        compoundVariants: [],
        defaultVariants: { variant: "ghost", size: "md" },
        problems: [],
      },
    ]);
  });

  it("follows a renamed import and reads boolean variants and compound variants", () => {
    const source = `
import { cva as variantsOf } from "class-variance-authority";
const tag = variantsOf("rounded", {
  variants: { tone: { ok: "bg-ok", bad: "bg-bad" }, pill: { true: "py-0.5", false: "" } },
  compoundVariants: [{ tone: ["ok", "bad"], pill: true, className: "font-bold" }],
  defaultVariants: { pill: false },
});`;
    const [definition] = findCvaDefinitions(source);
    expect(definition.name).toBe("tag");
    expect(definition.variants.pill).toEqual({ true: "py-0.5", false: "" });
    expect(definition.compoundVariants).toEqual([{ when: { tone: ["ok", "bad"], pill: "true" }, className: "font-bold" }]);
    expect(definition.defaultVariants).toEqual({ pill: "false" });
  });

  it("reports values it cannot read instead of guessing them", () => {
    const source = `
import { cva } from "class-variance-authority";
const shared = "p-2";
export const chip = cva(shared, { variants: { size: { md: \`h-7 \${shared}\`, ...more } } });`;
    const [definition] = findCvaDefinitions(source);
    expect(definition.base).toBe("");
    expect(definition.variants.size).toEqual({ md: "" });
    expect(definition.problems).toEqual([
      "Classes for base are not a literal string, so they are left out.",
      'Skipped a spread, method or computed key in variant "size".',
      "Classes for size.md are not a literal string, so they are left out.",
    ]);
  });

  it("finds several definitions in one file and names an unassigned one by its line", () => {
    const source = `
import { cva } from "class-variance-authority";
export const a = cva("a");
export const b = cva("b", { variants: { size: { sm: "text-xs" } } });
export default cva("c");`;
    expect(findCvaDefinitions(source).map(({ name, line }) => [name, line])).toEqual([
      ["a", 3],
      ["b", 4],
      ["cva at line 5", 5],
    ]);
  });

  it("throws on a file it cannot parse, so the caller can keep its last result", () => {
    const source = `
import { cva } from "class-variance-authority";
export const a = cva("a", { variants: { size: { sm: "text-xs", } } });
export const b = cva("b", { variants: { size: { sm: "text-xs"`;
    expect(() => findCvaDefinitions(source)).toThrow(SyntaxError);
  });

  it("skips files that do not import class-variance-authority", () => {
    expect(findCvaDefinitions(`const cva = () => ""; cva("a");`)).toEqual([]);
  });
});
