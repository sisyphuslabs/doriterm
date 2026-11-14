import { resolveTheme, themeVariables } from "@doriface/ui";
import { effective, single, type TerminalConfig } from "./config.ts";
import {
  builtinTheme,
  featureToCss,
  fontFamilyName,
  fontPixels,
  parseColor,
  parseMetric,
  parsePadding,
  parsePaletteEntry,
  parseTheme,
  variationToCss,
} from "./values.ts";

/** Specific enough to beat wterm's own `.wterm` rules and the app's inherit bridge. */
const T = ":root .wterm.wterm.wterm";

type Declarations = Record<string, string>;

const cssString = (name: string): string => `"${name.replace(/[\\"]/g, (char) => `\\${char}`)}"`;

const family = (names: readonly string[], fallback = "var(--font-term)"): string =>
  [...names.map((name) => cssString(fontFamilyName(name))), fallback].join(", ");

function cellColor(value: string, fallback: string): string {
  if (value === "cell-foreground") return "var(--term-cell-fg, var(--term-fg))";
  if (value === "cell-background") return "var(--term-cell-bg, var(--term-bg))";
  return parseColor(value) ?? fallback;
}

function themeDeclarations(name: string): Declarations {
  const palette = builtinTheme(name);
  if (palette === null) return {};
  const vars = themeVariables(resolveTheme(palette));
  const term = Object.entries(vars).filter(([prop]) => prop.startsWith("term-") && prop !== "term-cursor");
  return {
    ...Object.fromEntries(term.map(([prop, value]) => [`--${prop}`, value])),
    "--doriface-theme-cursor": vars["term-cursor"] ?? "",
  };
}

function block(selector: string, declarations: Declarations): string {
  const body = Object.entries(declarations).map(([prop, value]) => `  ${prop}: ${value};`);
  return body.length === 0 ? "" : `${selector} {\n${body.join("\n")}\n}\n`;
}

function rowHeight(config: TerminalConfig): string {
  const base = "calc(var(--term-font-pixels) * var(--term-line-height))";
  const pixel = "var(--term-device-pixel, 1px)";
  const metric = parseMetric(single(config, "adjust-cell-height"));
  if (metric === null) return `round(${base}, ${pixel})`;
  return metric.percent
    ? `round(calc(${base} * ${1 + metric.amount / 100}), ${pixel})`
    : `round(calc(${base} + ${metric.amount}px), ${pixel})`;
}

/** Turns the config into one stylesheet scoped to terminals; colors cascade into wterm's --term-* vars. */
export function terminalCss(config: TerminalConfig): string {
  const vars: Declarations = {
    "--term-font-size": `${single(config, "font-size")}pt`,
    "--term-font-pixels": `${fontPixels(Number(single(config, "font-size")), typeof navigator === "undefined" ? "" : navigator.platform)}px`,
    "font-size": "var(--term-font-pixels)",
    "--term-row-height": rowHeight(config),
  };
  const families = effective(config, "font-family");
  if (families.length > 0) vars["--term-font-family"] = family(families);
  const features = effective(config, "font-feature")
    .flatMap((line) => line.split(","))
    .map(featureToCss);
  if (features.length > 0) vars["font-feature-settings"] = features.filter((f) => f !== null).join(", ");
  const variations = effective(config, "font-variation")
    .map(variationToCss)
    .filter((v) => v !== null);
  if (variations.length > 0) vars["font-variation-settings"] = variations.join(", ");

  for (const [key, prop] of [
    ["background", "--term-bg"],
    ["foreground", "--term-fg"],
  ] as const) {
    const color = parseColor(single(config, key));
    if (color !== null) vars[prop] = color;
  }
  for (const line of effective(config, "palette")) {
    const entry = parsePaletteEntry(line);
    if (entry !== null && entry.index < 16) vars[`--term-color-${entry.index}`] = entry.color;
  }
  const cursor = single(config, "cursor-color");
  const opacity = Number(single(config, "cursor-opacity"));
  const cursorBase = cursor === "" ? "var(--doriface-theme-cursor)" : cellColor(cursor, "var(--doriface-theme-cursor)");
  vars["--term-cursor"] =
    opacity >= 1 ? cursorBase : `color-mix(in srgb, ${cursorBase} ${opacity * 100}%, transparent)`;
  const selection = single(config, "selection-background");
  if (selection !== "") vars["--term-selection-bg"] = cellColor(selection, "");
  const bgOpacity = Number(single(config, "background-opacity"));
  if (bgOpacity < 1) vars["background-color"] = `color-mix(in srgb, var(--term-bg) ${bgOpacity * 100}%, transparent)`;
  const [left = 2, right = left] = parsePadding(single(config, "window-padding-x")) ?? [];
  const [top = 2, bottom = top] = parsePadding(single(config, "window-padding-y")) ?? [];
  vars["padding"] = `${top}px ${right}px ${bottom}px ${left}px`;

  const theme = parseTheme(single(config, "theme"));
  const rules = [
    block(":root", { "--doriface-theme-cursor": "var(--term-cursor)" }),
    theme === null
      ? ""
      : block(`@media (prefers-color-scheme: light) { ${T}`, themeDeclarations(theme.light)).replace(/\n$/, " }\n"),
    theme === null
      ? ""
      : block(`@media (prefers-color-scheme: dark) { ${T}`, themeDeclarations(theme.dark)).replace(/\n$/, " }\n"),
    block(T, vars),
    ...styleRules(config),
    ...cursorRules(config),
    ...selectionRules(config),
  ];
  return rules.join("");
}

function styleRules(config: TerminalConfig): string[] {
  const span = `${T} .term-row span`;
  const styles = [
    ["font-family-bold", `${span}[style*="font-weight:bold"]:not([style*="font-style:italic"])`],
    ["font-family-italic", `${span}[style*="font-style:italic"]:not([style*="font-weight:bold"])`],
    ["font-family-bold-italic", `${span}[style*="font-weight:bold"][style*="font-style:italic"]`],
  ] as const;
  const rules = styles.map(([key, selector]) => {
    const names = effective(config, key);
    return names.length === 0 ? "" : block(selector, { "font-family": family(names, "var(--term-font-family)") });
  });
  if (single(config, "font-thicken") === "true")
    rules.push(block(`${T} .term-row`, { "-webkit-text-stroke": "0.25px currentColor" }));
  const width = parseMetric(single(config, "adjust-cell-width"));
  const nativeSpacing = "var(--term-native-spacing, 0px)";
  if (width !== null) {
    const spacing = width.percent ? `calc(1ch * ${width.amount / 100})` : `${width.amount}px`;
    rules.push(block(`${T} .term-row`, { "letter-spacing": `calc(${nativeSpacing} + ${spacing})` }));
  } else rules.push(block(`${T} .term-row`, { "letter-spacing": nativeSpacing }));
  const unfocused = single(config, "unfocused-split-opacity");
  rules.push(block('[data-split="true"][data-focused="false"] .wterm', { opacity: unfocused }));
  return rules;
}

function cursorRules(config: TerminalConfig): string[] {
  const rules: string[] = [];
  const text = single(config, "cursor-text");
  if (text !== "") rules.push(block(`${T}:is(.focused, :active) .term-cursor`, { color: cellColor(text, "inherit") }));
  if (single(config, "cursor-style") === "block_hollow") {
    const grid = '.term-grid:not([data-cursor-shape="bar"]):not([data-cursor-shape="underline"])';
    rules.push(
      block(`${T}.cursor-hollow:is(.focused, :active) ${grid} .term-cursor`, {
        background: "var(--term-cell-bg, transparent)",
        color: "var(--term-cell-fg, inherit)",
        outline: "1px solid var(--term-app-cursor, var(--term-cursor))",
        "outline-offset": "-1px",
      }),
    );
  }
  return rules;
}

function selectionRules(config: TerminalConfig): string[] {
  const background = single(config, "selection-background");
  const foreground = single(config, "selection-foreground");
  const declarations: Declarations = {};
  if (background !== "") declarations["background"] = cellColor(background, "");
  if (foreground !== "") declarations["color"] = cellColor(foreground, "");
  return [
    block(`${T} ::selection`, declarations),
    // A held finger selects the word under it (long-press.ts, #195), and the browser's own long-press selection and
    // callout would take the same gesture: under a coarse pointer the rows are not natively selectable, and the app
    // builds, paints and copies the range itself. A mouse keeps its drag selection.
    block(`@media (pointer: coarse) { ${T} .term-row`, {
      "user-select": "none",
      "-webkit-touch-callout": "none",
    }).replace(/\n$/, " }\n"),
    // Inside rows the selected cells are painted whole by use-selection-cells.ts, as Ghostty does; the browser's
    // highlight would follow each glyph's box instead (#410). A cell with a background of its own is drawn over that
    // layer, so it keeps the browser's highlight.
    block(`${T} .term-row ::selection`, { "background-color": "transparent" }),
    block(`${T} .term-row [style*="--term-cell-bg"]::selection, ${T} .term-row [style*="--term-cell-bg"] ::selection`, {
      "background-color": "var(--term-selection-bg)",
    }),
  ];
}
