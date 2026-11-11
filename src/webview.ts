import "@vscode-elements/elements/dist/vscode-button/index.js";
import "@vscode-elements/elements/dist/vscode-option/index.js";
import "@vscode-elements/elements/dist/vscode-single-select/index.js";
import "@vscode-elements/elements/dist/vscode-textfield/index.js";
import "@vscode-elements/elements/dist/vscode-toolbar-button/index.js";
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
  background: Background;
}

type SavedState = Record<string, Settings>;

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
let saved: SavedState = vscode.getState() ?? {};
let selectedName = "";
// The extension compiles wrapper classes on request, so it is told only when they change.
let compiledWrapper = "";

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
  if (settings.wrapper !== compiledWrapper) {
    compiledWrapper = settings.wrapper;
    vscode.postMessage({ type: "extraClasses", classes: settings.wrapper });
  }
  const states = detectStates(definition, settings.element);
  const canvasSlot = element("div");
  const drawCanvas = () => canvasSlot.replaceChildren(canvas(view, definition, states, settingsFor(definition)));

  app.append(controls(view, definition, states, settings, drawCanvas));
  for (const problem of definition.problems) {
    app.append(element("p", { className: "notice" }, problem));
  }
  if (view.error) {
    app.append(element("p", { className: "notice error" }, view.error));
  }
  app.append(canvasSlot);
  drawCanvas();
}

function defaultSettings(definition: CvaDefinition): Settings {
  const keys = Object.keys(definition.variants);
  return {
    rows: keys[0] ?? NO_AXIS,
    columns: keys[1] ?? STATE_AXIS,
    fixed: Object.fromEntries(keys.map((key) => [key, definition.defaultVariants[key] ?? UNSET])),
    state: REST,
    element: guessElement(definition.name),
    text: "",
    wrapper: "",
    background: "white",
  };
}

function settingsFor(definition: CvaDefinition): Settings {
  const defaults = defaultSettings(definition);
  const stored = saved[definition.name];
  const axes = [...Object.keys(definition.variants), STATE_AXIS, NO_AXIS];
  const storedAxesExist = stored && axes.includes(stored.rows) && axes.includes(stored.columns);
  if (!storedAxesExist) {
    return defaults;
  }
  const fixed = { ...defaults.fixed };
  for (const [key, value] of Object.entries(stored.fixed)) {
    const valueStillExists = key in definition.variants && (value === UNSET || value in definition.variants[key]);
    if (valueStillExists) {
      fixed[key] = value;
    }
  }
  return { ...defaults, ...stored, fixed };
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

function controls(
  view: ToWebview,
  definition: CvaDefinition,
  states: PreviewState[],
  settings: Settings,
  drawCanvas: () => void,
): HTMLElement {
  const keys = Object.keys(definition.variants);
  const save = (change: Partial<Settings>) => {
    saved = { ...saved, [definition.name]: { ...settings, ...change } };
    vscode.setState(saved);
  };
  const apply = (change: Partial<Settings>) => {
    save(change);
    render(view);
  };
  const axisOptions: Array<[string, string]> = [
    ...keys.map((key): [string, string] => [key, key]),
    [STATE_AXIS, "State"],
    [NO_AXIS, "Nothing"],
  ];
  // Rows and columns showing the same thing would only repeat one row, so picking the other axis's value swaps them.
  const pickAxis = (axis: "rows" | "columns", value: string) => {
    const other = axis === "rows" ? "columns" : "rows";
    const takesOtherAxis = value === settings[other] && value !== NO_AXIS;
    apply(takesOtherAxis ? { [axis]: value, [other]: settings[axis] } : { [axis]: value });
  };
  const swap = element("vscode-toolbar-button", { icon: "arrow-swap", label: "Swap rows and columns" });
  swap.title = "Swap rows and columns";
  swap.addEventListener("click", () => apply({ rows: settings.columns, columns: settings.rows }));

  const isDefault = JSON.stringify(settings) === JSON.stringify(defaultSettings(definition));
  const reset = element("vscode-button", { secondary: true, icon: "discard", disabled: isDefault }, "Reset");
  reset.addEventListener("click", () => {
    const { [definition.name]: _removed, ...others } = saved;
    saved = others;
    vscode.setState(saved);
    render(view);
  });

  const valueFields = keys
    .filter((key) => key !== settings.rows && key !== settings.columns)
    .map((key) => {
      const values = Object.keys(definition.variants[key]).map((value): [string, string] => [
        value,
        value === definition.defaultVariants[key] ? `${value} (default)` : value,
      ]);
      const options: Array<[string, string]> = key in definition.defaultVariants ? values : [[UNSET, "Unset"], ...values];
      return field(key, select(options, settings.fixed[key], (value) => apply({ fixed: { ...settings.fixed, [key]: value } })));
    });
  const stateOnAxis = settings.rows === STATE_AXIS || settings.columns === STATE_AXIS;
  if (!stateOnAxis && states.length > 1) {
    const stateOptions = states.map(({ id }): [string, string] => [id, id === REST ? `${id} (default)` : id]);
    valueFields.push(field("State", select(stateOptions, settings.state, (state) => apply({ state }))));
  }

  const text = textField(settings.text, "Value name");
  text.addEventListener("input", () => {
    save({ text: text.value });
    drawCanvas();
  });
  const wrapper = textField(settings.wrapper, "Classes; groups each row");
  wrapper.addEventListener("change", () => apply({ wrapper: wrapper.value.trim() }));

  const heading =
    view.definitions.length > 1
      ? select(
          view.definitions.map(({ name }): [string, string] => [name, name]),
          definition.name,
          (name) => {
            selectedName = name;
            vscode.postMessage({ type: "select", name });
            render(view);
          },
        )
      : element("strong", {}, definition.name);

  return element(
    "div",
    { className: "controls" },
    element("div", { className: "controls-header" }, heading, reset),
    ...group(
      "Grid",
      field("Rows", select(axisOptions, settings.rows, (value) => pickAxis("rows", value))),
      swap,
      field("Columns", select(axisOptions, settings.columns, (value) => pickAxis("columns", value))),
    ),
    ...(valueFields.length > 0 ? group("Fixed", ...valueFields) : []),
    ...group(
      "Render",
      field("Element", select(ELEMENT_OPTIONS, settings.element, (kind) => apply({ element: kind }))),
      field("Text", text),
      field("Wrapper", wrapper),
      field("Background", select(BACKGROUND_OPTIONS, settings.background, (background) => apply({ background }))),
    ),
  );
}

function group(label: string, ...children: HTMLElement[]): HTMLElement[] {
  return [element("span", { className: "group-label" }, label), element("div", { className: "group" }, ...children)];
}

function field(label: string, control: HTMLElement): HTMLElement {
  return element("div", { className: "field" }, element("span", {}, label), control);
}

function canvas(view: ToWebview, definition: CvaDefinition, states: PreviewState[], settings: Settings): HTMLElement {
  const host = element("section", { className: "canvas" });
  host.style.background = BACKGROUNDS[settings.background];
  host.dataset.background = settings.background;
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
  options: Array<[Value, string]>,
  value: Value,
  onChange: (value: Value) => void,
): HTMLElement {
  const input = element(
    "vscode-single-select",
    {},
    ...options.map(([optionValue, optionLabel]) =>
      element("vscode-option", { value: optionValue, selected: optionValue === value }, optionLabel),
    ),
  );
  input.addEventListener("change", () => onChange(options[input.selectedIndex][0]));
  return input;
}

function textField(value: string, placeholder: string) {
  return element("vscode-textfield", { value, placeholder });
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
