import { BUILTIN_PALETTES, LIBRARY_CREDITS, LIBRARY_PALETTES, type Palette } from "@doriface/ui";
import type { Kind } from "./schema.ts";

export const THEME_NAMES = ["Night", "Day", "Graphite", "Paper"] as const;

/** Ghostty's native point uses 72 DPI on Apple platforms, 96 elsewhere. CSS always uses 96 DPI. */
export function fontPixels(points: number, platform: string): number {
  return points * (/Mac|iPhone|iPad|iPod/i.test(platform) ? 1 : 96 / 72);
}

/** A quoted config value names the family inside the quotes, rather than a family whose name contains them. */
export function fontFamilyName(value: string): string {
  const quote = value[0];
  return value.length > 1 && (quote === "'" || quote === '"') && value.endsWith(quote) ? value.slice(1, -1) : value;
}

/** Ghostty theme names are case sensitive on disk; ours match case-insensitively, by name or id (#512). */
export function builtinTheme(name: string): Palette | null {
  const key = name.trim().toLowerCase();
  if (key === "night" || key === "day" || key === "graphite" || key === "paper") return BUILTIN_PALETTES[key];
  const library = Object.entries(LIBRARY_CREDITS).find(
    ([id, credit]) => id === key || credit.name.toLowerCase() === key,
  )?.[0];
  return library === undefined ? null : LIBRARY_PALETTES[library as keyof typeof LIBRARY_PALETTES];
}

export type Checked = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const OK: Checked = { ok: true };
const bad = (reason: string): Checked => ({ ok: false, reason });
const HEX = /^#?[0-9a-f]{6}$/i;
const NUMBER = /^-?\d+(\.\d+)?$/;

/** Ghostty accepts `#RRGGBB` and `RRGGBB`; returns `#rrggbb` or null. */
export function parseColor(value: string): string | null {
  return HEX.test(value) ? `#${value.replace("#", "").toLowerCase()}` : null;
}

/** A palette index in decimal, or with a 0x / 0o / 0b prefix. */
export function parseIndex(text: string): number | null {
  const match = /^(0x[0-9a-f]+|0o[0-7]+|0b[01]+|\d+)$/i.exec(text.trim());
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value >= 0 && value <= 255 ? value : null;
}

/** `N=COLOR` with N in 0-255. */
export function parsePaletteEntry(value: string): { readonly index: number; readonly color: string } | null {
  const eq = value.indexOf("=");
  if (eq === -1) return null;
  const index = parseIndex(value.slice(0, eq));
  const color = parseColor(value.slice(eq + 1).trim());
  return index === null || color === null ? null : { index, color };
}

/** `light:X,dark:Y` in any order, or one name for both. */
export function parseTheme(value: string): { readonly light: string; readonly dark: string } | null {
  if (!value.includes(":")) return value === "" ? null : { light: value, dark: value };
  const parts = new Map<string, string>();
  for (const part of value.split(",")) {
    const colon = part.indexOf(":");
    const side = part.slice(0, colon).trim();
    if (colon === -1 || parts.has(side)) return null;
    parts.set(side, part.slice(colon + 1).trim());
  }
  const light = parts.get("light");
  const dark = parts.get("dark");
  return light === undefined || dark === undefined || light === "" || dark === "" || parts.size !== 2
    ? null
    : { light, dark };
}

/** One font feature in Ghostty's loose syntax, as a CSS `font-feature-settings` entry. */
export function featureToCss(feature: string): string | null {
  const text = feature.trim().replace(/["']/g, "");
  const match = /^([+-]?)([a-zA-Z0-9]{4})(?:\s*(?:=|\s)\s*(on|off|\d+))?$/.exec(text);
  if (match === null) return null;
  const [, sign = "", tag = "", setting] = match;
  const value = sign === "-" || setting === "off" ? 0 : setting === undefined || setting === "on" ? 1 : Number(setting);
  return Number.isFinite(value) ? `"${tag}" ${value}` : null;
}

/** `wght=600` as a CSS `font-variation-settings` entry. */
export function variationToCss(variation: string): string | null {
  const match = /^\s*([a-zA-Z0-9]{4})\s*=\s*(-?\d+(?:\.\d+)?)\s*$/.exec(variation);
  return match === null ? null : `"${match[1]}" ${match[2]}`;
}

/** An adjustment: `1`, `-2`, or `20%`. */
export function parseMetric(value: string): { readonly amount: number; readonly percent: boolean } | null {
  const match = /^(-?\d+(?:\.\d+)?)(%?)$/.exec(value.trim());
  const amount = Number(match?.[1]);
  return match === null || !Number.isFinite(amount) ? null : { amount, percent: match[2] === "%" };
}

export function parsePadding(value: string): readonly [number, number] | null {
  const parts = value.split(",").map((part) => part.trim());
  if (parts.length > 2 || parts.some((part) => !/^\d+$/.test(part))) return null;
  const [first = "0", second = first] = parts;
  const sides = [Number(first), Number(second)] as const;
  return sides.every(Number.isFinite) ? sides : null;
}

/** Checks one value against its key's kind. */
export function checkValue(kind: Kind, value: string): Checked {
  switch (kind.type) {
    case "text":
      return OK;
    case "number":
    case "integer": {
      if (!NUMBER.test(value)) return bad("expects a number");
      const number = Number(value);
      if (kind.type === "integer" && !Number.isInteger(number)) return bad("expects a whole number");
      return number < kind.min || number > kind.max ? bad(`expects ${kind.min} to ${kind.max}`) : OK;
    }
    case "bool":
      return value === "true" || value === "false" ? OK : bad("expects true or false");
    case "optional-bool":
      return value === "" || value === "true" || value === "false" ? OK : bad("expects true, false or nothing");
    case "enum":
      return kind.values.includes(value) ? OK : bad(`expects one of ${kind.values.join(", ")}`);
    case "color":
      if (kind.cellColors && (value === "cell-foreground" || value === "cell-background")) return OK;
      return parseColor(value) === null ? bad("expects #RRGGBB (named X11 colors are not supported here)") : OK;
    case "metric":
      return parseMetric(value) === null ? bad("expects a number of pixels or a percentage") : OK;
    case "palette": {
      const entry = parsePaletteEntry(value);
      if (entry === null) return bad("expects N=#RRGGBB with N from 0 to 255");
      return entry.index > 15 ? bad("this renderer themes palette 0-15 only") : OK;
    }
    case "feature":
      return value.split(",").every((part) => featureToCss(part) !== null)
        ? OK
        : bad("expects features like -calt or ss01");
    case "variation":
      return variationToCss(value) === null ? bad("expects id=value, e.g. wght=600") : OK;
    case "theme": {
      const theme = parseTheme(value);
      if (theme === null) return bad("expects a theme name or light:X,dark:Y");
      const missing = [theme.light, theme.dark].find((name) => builtinTheme(name) === null);
      return missing === undefined
        ? OK
        : bad(`"${missing}" is not a theme Doriterm has: one of ${THEME_NAMES.join(", ")} or a theme from Appearance`);
    }
    case "padding":
      return parsePadding(value) === null ? bad("expects pixels, or two values like 4,8") : OK;
  }
}
