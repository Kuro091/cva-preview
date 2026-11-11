import { parse } from "@babel/parser";
import type { Node, ObjectExpression, ObjectProperty } from "@babel/types";

export type CompoundCondition = string | string[];

export interface CvaDefinition {
  name: string;
  line: number;
  base: string;
  variants: Record<string, Record<string, string>>;
  compoundVariants: Array<{ when: Record<string, CompoundCondition>; className: string }>;
  defaultVariants: Record<string, string>;
  problems: string[];
}

const CVA_MODULE = "class-variance-authority";

export function findCvaDefinitions(source: string): CvaDefinition[] {
  if (!source.includes(CVA_MODULE)) {
    return [];
  }
  const { program } = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"], errorRecovery: true });
  const cvaNames = new Set<string>();
  const definitions: CvaDefinition[] = [];

  walk(program, null, (node) => {
    if (node.type === "ImportDeclaration" && node.source.value === CVA_MODULE) {
      for (const specifier of node.specifiers) {
        const importsCva =
          specifier.type === "ImportSpecifier" &&
          (specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value) === "cva";
        if (importsCva) {
          cvaNames.add(specifier.local.name);
        }
      }
    }
  });

  walk(program, null, (node, parent) => {
    const isCvaCall = node.type === "CallExpression" && node.callee.type === "Identifier" && cvaNames.has(node.callee.name);
    if (!isCvaCall) {
      return;
    }
    const line = node.loc!.start.line;
    const name =
      parent?.type === "VariableDeclarator" && parent.id.type === "Identifier" ? parent.id.name : `cva at line ${line}`;
    definitions.push(readDefinition(name, line, node.arguments));
  });

  return definitions;
}

function readDefinition(name: string, line: number, [baseArgument, configArgument]: Node[]): CvaDefinition {
  const problems: string[] = [];
  const definition: CvaDefinition = {
    name,
    line,
    base: baseArgument ? readClasses(baseArgument, "base", problems) : "",
    variants: {},
    compoundVariants: [],
    defaultVariants: {},
    problems,
  };
  if (!configArgument) {
    return definition;
  }
  if (configArgument.type !== "ObjectExpression") {
    problems.push("The config is not an object literal.");
    return definition;
  }

  const variants = property(configArgument, "variants");
  if (variants?.type === "ObjectExpression") {
    for (const [key, values] of entries(variants, problems, "variants")) {
      if (values.type !== "ObjectExpression") {
        problems.push(`Variant "${key}" is not an object literal.`);
        continue;
      }
      definition.variants[key] = {};
      for (const [value, classes] of entries(values, problems, `variant "${key}"`)) {
        definition.variants[key][value] = readClasses(classes, `${key}.${value}`, problems);
      }
    }
  }

  const defaults = property(configArgument, "defaultVariants");
  if (defaults?.type === "ObjectExpression") {
    for (const [key, value] of entries(defaults, problems, "defaultVariants")) {
      const literal = readLiteralKey(value);
      if (literal === undefined) {
        problems.push(`Default for "${key}" is not a literal.`);
      } else {
        definition.defaultVariants[key] = literal;
      }
    }
  }

  const compounds = property(configArgument, "compoundVariants");
  if (compounds?.type === "ArrayExpression") {
    compounds.elements.forEach((element, index) => {
      if (element?.type !== "ObjectExpression") {
        problems.push(`Compound variant ${index + 1} is not an object literal.`);
        return;
      }
      const when: Record<string, CompoundCondition> = {};
      let className = "";
      for (const [key, value] of entries(element, problems, `compound variant ${index + 1}`)) {
        if (key === "class" || key === "className") {
          className = readClasses(value, `compound variant ${index + 1}`, problems);
        } else if (value.type === "ArrayExpression") {
          when[key] = value.elements.map(readLiteralKey).filter((item) => item !== undefined);
        } else {
          const literal = readLiteralKey(value);
          if (literal === undefined) {
            problems.push(`Compound variant ${index + 1} condition "${key}" is not a literal.`);
          } else {
            when[key] = literal;
          }
        }
      }
      definition.compoundVariants.push({ when, className });
    });
  }

  return definition;
}

function property(object: ObjectExpression, name: string): Node | undefined {
  const found = object.properties.find(
    (candidate): candidate is ObjectProperty => candidate.type === "ObjectProperty" && keyName(candidate) === name,
  );
  return found?.value;
}

function entries(object: ObjectExpression, problems: string[], where: string): Array<[string, Node]> {
  const result: Array<[string, Node]> = [];
  for (const candidate of object.properties) {
    const key = candidate.type === "ObjectProperty" ? keyName(candidate) : undefined;
    if (candidate.type !== "ObjectProperty" || key === undefined) {
      problems.push(`Skipped a spread, method or computed key in ${where}.`);
      continue;
    }
    result.push([key, candidate.value]);
  }
  return result;
}

function keyName(candidate: ObjectProperty): string | undefined {
  if (candidate.computed) {
    return undefined;
  }
  const { key } = candidate;
  if (key.type === "Identifier") {
    return key.name;
  }
  if (key.type === "StringLiteral" || key.type === "NumericLiteral") {
    return String(key.value);
  }
  return undefined;
}

function readLiteralKey(node: Node | null): string | undefined {
  if (node && (node.type === "StringLiteral" || node.type === "NumericLiteral" || node.type === "BooleanLiteral")) {
    return String(node.value);
  }
  return undefined;
}

function readClasses(node: Node | null, where: string, problems: string[]): string {
  switch (node?.type) {
    case "StringLiteral":
      return node.value;
    case "TemplateLiteral":
      if (node.expressions.length === 0) {
        return node.quasis[0].value.raw;
      }
      break;
    case "ArrayExpression":
      return node.elements
        .map((element) => readClasses(element, where, problems))
        .filter(Boolean)
        .join(" ");
    case "NullLiteral":
      return "";
    case "BooleanLiteral":
      if (!node.value) {
        return "";
      }
      break;
  }
  problems.push(`Classes for ${where} are not a literal string, so they are left out.`);
  return "";
}

function walk(node: Node, parent: Node | null, visit: (node: Node, parent: Node | null) => void): void {
  visit(node, parent);
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        if (isNode(item)) {
          walk(item, node, visit);
        }
      }
    } else if (isNode(child)) {
      walk(child, node, visit);
    }
  }
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}
