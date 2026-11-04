import { hex, mix, parseRgba, type Rgb } from "./color.ts";
import { AA_GRAPHIC, AA_TEXT, ensureContrast, flatten } from "./guard.ts";
import type { ResolvedTheme } from "./resolve.ts";

/** CSS custom properties, without the leading `--`. */
export type CssVariables = Readonly<Record<string, string>>;

const STATUSES = ["working", "blocked", "done", "idle", "unknown"] as const;
/** The chip behind a status label: the status colour at 15% (herdr-app's `+ "26"`). */
const CHIP_ALPHA = 0x26 / 255;

function rgb(value: string): Rgb {
  const parsed = parseRgba(value);
  if (parsed === undefined) throw new TypeError(`${value} is not a colour`);
  return parsed.rgb;
}

/**
 * Projects a resolved theme onto doriface's CSS contract: shadcn-compatible names for
 * components, `--status-*` for agent state and `--term-*` for the terminal renderer.
 * Text and control-edge roles pass through an AA guard against every surface they sit on.
 */
export function themeVariables(theme: ResolvedTheme): CssVariables {
  const r = theme.roles;
  const base = rgb(r.background);
  const ink = rgb(r.foreground);
  const canvas = rgb(r.canvas);
  const chrome = rgb(r.chrome);
  const popover = flatten(r.popover, base);
  const selected = [base, canvas, chrome, popover].map((under) => flatten(r.selected, under));
  const surfaces = [base, canvas, chrome, popover, flatten(r.raised, base), ...selected];
  const text = (value: string): string => ensureContrast(value, surfaces, AA_TEXT, ink);
  const graphic = (value: string): string => ensureContrast(value, surfaces, AA_GRAPHIC, ink);
  const termBg = rgb(r.background);
  /** Terminal text reaches AA on its own background (Ghostty's `minimum-contrast`); passing palettes are unchanged. */
  const termText = ensureContrast(r.terminal_foreground, [termBg], AA_TEXT, ink);
  const termFg = rgb(termText);
  /** Ghostty draws faint text at faint-opacity 0.5; the guard lifts it to AA on the terminal background. */
  const faint = ensureContrast(hex(mix(termBg, termFg, 0.5)), [termBg], AA_TEXT, termFg);
  const edge = ensureContrast(hex(mix(base, ink, 0.3)), surfaces, AA_GRAPHIC, ink);
  const vars: Record<string, string> = {
    background: r.canvas,
    foreground: r.foreground,
    canvas: r.canvas,
    surface: r.surface,
    chrome: r.chrome,
    raised: r.raised,
    hover: r.hover,
    selected: r.selected,
    card: r.surface,
    "card-foreground": r.foreground,
    popover: r.popover,
    "popover-foreground": r.foreground,
    primary: r.solid,
    "primary-foreground": r.solid_foreground,
    secondary: r.raised,
    "secondary-foreground": r.foreground,
    muted: r.raised,
    "muted-foreground": text(r.muted),
    dim: r.dim,
    accent: r.hover,
    "accent-foreground": r.foreground,
    brand: text(r.accent),
    "brand-foreground": r.accent_foreground,
    destructive: text(r.blocked),
    "destructive-foreground": r.solid_foreground,
    border: r.border,
    input: edge,
    ring: graphic(r.accent),
    selection: r.selection,
    sidebar: r.chrome,
    "sidebar-foreground": r.foreground,
    "sidebar-primary": r.solid,
    "sidebar-primary-foreground": r.solid_foreground,
    "sidebar-accent": r.hover,
    "sidebar-accent-foreground": r.foreground,
    "sidebar-border": r.border,
    "sidebar-ring": graphic(r.accent),
    "term-fg": termText,
    "term-bg": r.background,
    "term-faint": faint,
    "term-cursor": r.cursor,
    "term-selection": r.selection,
  };
  for (const status of STATUSES) {
    const color = graphic(r[status]);
    vars[`status-${status}`] = color;
    const chips = surfaces.map((surface) => mix(surface, rgb(color), CHIP_ALPHA));
    vars[`status-${status}-text`] = ensureContrast(color, chips, AA_TEXT, ink);
  }
  theme.ansi.forEach((value, index) => {
    vars[`term-color-${index}`] = value;
  });
  return vars;
}

/** A CSS rule that sets every theme variable, plus `color-scheme`, on `selector`. */
export function themeCss(selector: string, theme: ResolvedTheme): string {
  const lines = Object.entries(themeVariables(theme)).map(([name, value]) => `  --${name}: ${value};`);
  return `${selector} {\n  color-scheme: ${theme.light ? "light" : "dark"};\n${lines.join("\n")}\n}\n`;
}
