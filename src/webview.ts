import { cva } from "class-variance-authority";
import type { CvaDefinition } from "./parse";
import { FORCED_PSEUDO_CLASSES, type FromWebview, forcedAttribute, type ToWebview } from "./protocol";

declare function acquireVsCodeApi(): {
  postMessage(message: FromWebview): void;
  getState(): SavedState | undefined;
  setState(state: SavedState): void;
};

type ElementKind = "button" | "span" | "input" | "label";
type Background = "white" | "gray" | "dark";

interface Settings {
  rows: string;
  columns: string;
  fixed: Record<string, string>;
  state: string;
  element: ElementKind;
  text: string;
  wrapper: string;
}

interface SavedState {
  background: Background;
  byDefinition: Record<string, Settings>;
}

interface PreviewState {
  id: string;
  apply(element: HTMLElement, child: HTMLInputElement | undefined): void;
}

interface AxisValue {
  label: string;
  isDefault: boolean;
  props: Record<string, string>;
  state?: PreviewState;
}

const STATE_AXIS = "state";
const NO_AXIS = "none";
const UNSET = "";
const REST = "rest";
// Columns read like an interaction sequence: rest, hover, focus, then the selected and invalid states, disabled last.
const STATE_ORDER = ["hover", "focus", "focus-visible", "focus-within", "active", "aria", "data", "checked", "has", "disabled"];
const BACKGROUNDS: Record<Background, string> = { white: "#ffffff", gray: "#f3f4f6", dark: "#1f2529" };
const BACKGROUND_OPTIONS: Array<[Background, string]> = [
  ["white", "White"],
  ["gray", "Gray"],
  ["dark", "Dark"],
];
const ELEMENT_OPTIONS: Array<[ElementKind, string]> = [
  ["button", "Button"],
  ["span", "Span"],
  ["input", "Text input"],
  ["label", "Label around a radio"],
];
const SHADOW_BASE_CSS = `
:host { display: block; color: #111827; font-size: 16px; }
.cva-preview-grid { border-collapse: separate; border-spacing: 16px 12px; }
.cva-preview-head { font: 500 11px/1.3 system-ui, sans-serif; color: #6b7280; text-align: left; white-space: nowrap; }
:host([data-background="dark"]) .cva-preview-head { color: #9ca3af; }
.cva-preview-default { font-weight: 700; }
.cva-preview-cell { cursor: copy; vertical-align: middle; }
.cva-preview-hidden-input { position: absolute; opacity: 0; pointer-events: none; }
`;

const vscode = acquireVsCodeApi();
const app = document.body.appendChild(document.createElement("main"));
const propertyStyle = document.head.appendChild(document.createElement("style"));
let saved: SavedState = vscode.getState() ?? { background: "white", byDefinition: {} };
let selectedName = "";

window.addEventListener("message", (event: MessageEvent<ToWebview>) => {
  selectedName = event.data.selected;
  render(event.data);
});
vscode.postMessage({ type: "ready" });

function render(view: ToWebview): void {
  const definition = view.definitions.find((candidate) => candidate.name === selectedName);
  app.replaceChildren();
  if (!definition) {
    app.append(element("p", { className: "notice" }, `${view.fileName} has no cva definition.`));
    return;
  }
  propertyStyle.textContent = view.propertyCss;
  const settings = settingsFor(definition);
  const states = detectStates(definition, settings.element);
  app.append(toolbar(view, definition, states, settings));
  for (const problem of definition.problems) {
    app.append(element("p", { className: "notice" }, problem));
  }
  if (view.error) {
    app.append(element("p", { className: "notice error" }, view.error));
  }
  app.append(canvas(view, definition, states, settings));
}

function settingsFor(definition: CvaDefinition): Settings {
  const keys = Object.keys(definition.variants);
  const axes = [...keys, STATE_AXIS, NO_AXIS];
  const stored = saved.byDefinition[definition.name];
  const defaults: Settings = {
    rows: keys[0] ?? NO_AXIS,
    columns: keys[1] ?? STATE_AXIS,
    fixed: {},
    state: REST,
    element: guessElement(definition.name),
    text: "",
    wrapper: "",
  };
  const storedAxesExist = stored && axes.includes(stored.rows) && axes.includes(stored.columns);
  const settings = storedAxesExist ? { ...defaults, ...stored, fixed: { ...stored.fixed } } : defaults;
  for (const key of keys) {
    const values = Object.keys(definition.variants[key]);
    const fixedValueExists = settings.fixed[key] === UNSET || values.includes(settings.fixed[key]);
    if (!fixedValueExists) {
      settings.fixed[key] = definition.defaultVariants[key] ?? UNSET;
    }
  }
  return settings;
}

function guessElement(name: string): ElementKind {
  if (/field|input|textarea|select/i.test(name)) {
    return "input";
  }
  if (/button|btn|chip|segment|tab|toggle/i.test(name)) {
    return "button";
  }
  return "span";
}

function toolbar(view: ToWebview, definition: CvaDefinition, states: PreviewState[], settings: Settings): HTMLElement {
  const keys = Object.keys(definition.variants);
  const axisOptions: Array<[string, string]> = [
    ...keys.map((key): [string, string] => [key, key]),
    [STATE_AXIS, "State"],
    [NO_AXIS, "Nothing"],
  ];
  const update = (change: Partial<Settings>) => {
    saved = { ...saved, byDefinition: { ...saved.byDefinition, [definition.name]: { ...settings, ...change } } };
    vscode.setState(saved);
    render(view);
  };
  const bar = element("div", { className: "toolbar" });

  if (view.definitions.length > 1) {
    bar.append(
      select(
        "Definition",
        view.definitions.map((candidate) => [candidate.name, candidate.name]),
        definition.name,
        (name) => {
          selectedName = name;
          vscode.postMessage({ type: "select", name });
          render(view);
        },
      ),
    );
  }
  bar.append(
    select("Rows", axisOptions, settings.rows, (rows) => update({ rows })),
    select("Columns", axisOptions, settings.columns, (columns) => update({ columns })),
  );
  for (const key of keys.filter((candidate) => candidate !== settings.rows && candidate !== settings.columns)) {
    const values = Object.keys(definition.variants[key]).map((value): [string, string] => [value, value]);
    const options: Array<[string, string]> = key in definition.defaultVariants ? values : [[UNSET, "Unset"], ...values];
    bar.append(
      select(key, options, settings.fixed[key], (value) => update({ fixed: { ...settings.fixed, [key]: value } })),
    );
  }
  const stateOnAxis = settings.rows === STATE_AXIS || settings.columns === STATE_AXIS;
  if (!stateOnAxis && states.length > 1) {
    bar.append(
      select(
        "State",
        states.map((state) => [state.id, state.id]),
        settings.state,
        (state) => update({ state }),
      ),
    );
  }
  bar.append(
    select(
      "Element",
      ELEMENT_OPTIONS,
      settings.element,
      (kind) => update({ element: kind }),
    ),
    textField("Text", settings.text, "Value name", (text) => update({ text })),
    textField("Wrapper classes", settings.wrapper, "Groups each row", (wrapper) => {
      vscode.postMessage({ type: "extraClasses", classes: wrapper });
      update({ wrapper });
    }),
    select(
      "Background",
      BACKGROUND_OPTIONS,
      saved.background,
      (background) => {
        saved = { ...saved, background };
        vscode.setState(saved);
        render(view);
      },
    ),
  );
  return bar;
}

function canvas(view: ToWebview, definition: CvaDefinition, states: PreviewState[], settings: Settings): HTMLElement {
  const host = element("section", { className: "canvas" });
  host.style.background = BACKGROUNDS[saved.background];
  host.dataset.background = saved.background;
  const root = host.attachShadow({ mode: "open" });
  root.append(element("style", { textContent: SHADOW_BASE_CSS + view.css }));

  const variantsOf = cva(definition.base, {
    variants: definition.variants,
    compoundVariants: definition.compoundVariants.map(({ when, className }) => ({ ...when, className })),
    defaultVariants: definition.defaultVariants,
  });
  const fixedState = states.find((state) => state.id === settings.state);
  const rows = axisValues(definition, states, settings.rows);
  const columns = axisValues(definition, states, settings.columns);
  const grouped = settings.wrapper.trim() !== "";

  const table = element("table", { className: "cva-preview-grid" });
  if (!grouped && settings.columns !== NO_AXIS) {
    table.append(element("tr", {}, element("th"), ...columns.map(headCell)));
  }
  for (const row of rows) {
    const items = columns.map((column) => {
      const props = { ...settings.fixed, ...row.props, ...column.props };
      const className = variantsOf(props);
      const label = settings.text || column.label || row.label || definition.name;
      const item = previewElement(settings.element, className, label, row.state ?? column.state ?? fixedState);
      return { item, className, call: callText(definition, props) };
    });
    const tableRow = element("tr", {}, headCell(row));
    if (grouped) {
      const wrapper = element("div", { className: settings.wrapper }, ...items.map(({ item }) => item));
      tableRow.append(element("td", { className: "cva-preview-cell" }, wrapper));
    } else {
      for (const { item, className, call } of items) {
        const cell = element("td", { className: "cva-preview-cell", title: `${call}\n\n${className}` }, item);
        cell.addEventListener("click", () => vscode.postMessage({ type: "copy", text: call }));
        tableRow.append(cell);
      }
    }
    table.append(tableRow);
  }
  root.append(table);
  return host;
}

function axisValues(definition: CvaDefinition, states: PreviewState[], axis: string): AxisValue[] {
  if (axis === STATE_AXIS) {
    return states.map((state) => ({ label: state.id, isDefault: false, props: {}, state }));
  }
  if (axis === NO_AXIS) {
    return [{ label: "", isDefault: false, props: {} }];
  }
  return Object.keys(definition.variants[axis]).map((value) => ({
    label: value,
    isDefault: definition.defaultVariants[axis] === value,
    props: { [axis]: value },
  }));
}

function headCell({ label, isDefault }: AxisValue): HTMLElement {
  return element(
    "th",
    { className: isDefault ? "cva-preview-head cva-preview-default" : "cva-preview-head" },
    isDefault ? `${label} (default)` : label,
  );
}

function callText(definition: CvaDefinition, props: Record<string, string>): string {
  const changed = Object.entries(props).filter(
    ([key, value]) => value !== UNSET && value !== definition.defaultVariants[key],
  );
  if (changed.length === 0) {
    return `${definition.name}()`;
  }
  const literal = (value: string) => (value === "true" || value === "false" ? value : JSON.stringify(value));
  return `${definition.name}({ ${changed.map(([key, value]) => `${key}: ${literal(value)}`).join(", ")} })`;
}

function previewElement(
  kind: ElementKind,
  className: string,
  label: string,
  state: PreviewState | undefined,
): HTMLElement {
  let item: HTMLElement;
  let child: HTMLInputElement | undefined;
  switch (kind) {
    case "button":
      item = element("button", { type: "button", className }, label);
      break;
    case "input":
      item = element("input", { className, placeholder: label });
      break;
    case "label":
      child = element("input", { type: "radio", className: "cva-preview-hidden-input", tabIndex: -1 });
      item = element("label", { className }, child, label);
      break;
    case "span":
      item = element("span", { className }, label);
      break;
  }
  state?.apply(item, child);
  return item;
}

function detectStates(definition: CvaDefinition, kind: ElementKind): PreviewState[] {
  const classes = [
    definition.base,
    ...Object.values(definition.variants).flatMap((values) => Object.values(values)),
    ...definition.compoundVariants.map((compound) => compound.className),
  ].join(" ");
  const prefixes = new Set(classes.split(/\s+/).flatMap((token) => splitVariants(token).slice(0, -1)));
  const hasChildInput = kind === "label";
  const states = [...prefixes]
    .filter((prefix) => hasChildInput || !prefix.startsWith("has-"))
    .map(stateFor)
    .filter((state) => state !== undefined)
    .sort((a, b) => stateRank(a.id) - stateRank(b.id));
  return [{ id: REST, apply: () => {} }, ...states];
}

function stateRank(id: string): number {
  const exact = STATE_ORDER.indexOf(id);
  return exact === -1 ? STATE_ORDER.indexOf(id.split("-")[0]) : exact;
}

function splitVariants(token: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < token.length; index++) {
    const character = token[index];
    if (character === "[" || character === "(") {
      depth++;
    } else if (character === "]" || character === ")") {
      depth--;
    } else if (character === ":" && depth === 0) {
      parts.push(token.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(token.slice(start));
  return parts;
}

function stateFor(prefix: string): PreviewState | undefined {
  const isForcedPseudoClass = FORCED_PSEUDO_CLASSES.includes(prefix);
  if (isForcedPseudoClass) {
    return { id: prefix, apply: (item) => item.setAttribute(forcedAttribute(prefix), "") };
  }
  if (prefix === "disabled") {
    return { id: prefix, apply: (item, child) => (child ?? item).setAttribute("disabled", "") };
  }
  if (prefix === "checked") {
    return { id: prefix, apply: (item) => item.setAttribute("checked", "") };
  }
  if (prefix.startsWith("has-")) {
    const inner = stateFor(prefix.slice("has-".length));
    return inner && { id: prefix, apply: (_item, child) => child && inner.apply(child, undefined) };
  }
  const attribute = /^(aria|data)-(?:\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]|([\w-]+))$/.exec(prefix);
  if (attribute) {
    const [, kind, arbitraryName, arbitraryValue, name] = attribute;
    const value = arbitraryValue ?? (kind === "aria" ? "true" : "");
    return {
      id: prefix,
      apply: (item) => item.setAttribute(`${kind}-${arbitraryName ?? name}`, value),
    };
  }
  return undefined;
}

function select<Value extends string>(
  label: string,
  options: Array<[Value, string]>,
  value: Value,
  onChange: (value: Value) => void,
): HTMLElement {
  const input = element(
    "select",
    {},
    ...options.map(([optionValue, optionLabel]) =>
      element("option", { value: optionValue, selected: optionValue === value }, optionLabel),
    ),
  );
  input.addEventListener("change", () => onChange(options[input.selectedIndex][0]));
  return element("label", { className: "control" }, element("span", {}, label), input);
}

function textField(label: string, value: string, placeholder: string, onChange: (value: string) => void): HTMLElement {
  const input = element("input", { value, placeholder });
  input.addEventListener("change", () => onChange(input.value));
  return element("label", { className: "control" }, element("span", {}, label), input);
}

function element<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  properties: Partial<HTMLElementTagNameMap[Tag]> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[Tag] {
  const created = Object.assign(document.createElement(tag), properties);
  created.append(...children);
  return created;
}
