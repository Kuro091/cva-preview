import type { CvaDefinition } from "./parse";

// Pseudo-classes that cannot be switched on from script, so the preview CSS also matches them on a data attribute.
export const FORCED_PSEUDO_CLASSES: readonly string[] = ["hover", "focus", "focus-visible", "focus-within", "active"];

export const forcedAttribute = (pseudoClass: string) => `data-preview-${pseudoClass}`;

export type ToWebview = {
  type: "update";
  fileName: string;
  definitions: CvaDefinition[];
  selected: string;
  css: string;
  propertyCss: string;
  error?: string;
};

export type FromWebview =
  | { type: "ready" }
  | { type: "select"; name: string }
  | { type: "extraClasses"; classes: string }
  | { type: "copy"; text: string };
