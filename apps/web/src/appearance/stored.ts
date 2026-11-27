import { parseThemeFile, resolveTheme, themeVariables } from "@doriface/ui";
import { themeChoices, type CustomTheme } from "./choices.ts";

export type AppearanceMode = "system" | "light" | "dark";
/** Row height of the UI chrome (sidebar, lists, menus); the terminal font is its own setting. */
export type Density = "compact" | "comfortable" | "spacious";

export interface Appearance {
  /** "system" uses `light` or `dark` as the device asks; "light" and "dark" pin one of them. */
  readonly mode: AppearanceMode;
  /** The theme id used when the appearance is dark, and when it is light. */
  readonly dark: string;
  readonly light: string;
  readonly density: Density;
  readonly custom: readonly CustomTheme[];
}

export const DEFAULT_APPEARANCE: Appearance = {
  mode: "dark",
  dark: "night",
  light: "day",
  density: "comfortable",
  custom: [],
};

const MODES: readonly AppearanceMode[] = ["system", "light", "dark"];
const DENSITIES: readonly Density[] = ["compact", "comfortable", "spacious"];

function isCustomTheme(value: unknown): value is CustomTheme {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "id") === "string" &&
    typeof Reflect.get(value, "name") === "string"
  );
}

const text = (record: object, key: string): string | undefined => {
  const value: unknown = Reflect.get(record, key);
  return typeof value === "string" ? value : undefined;
};

/**
 * The stored appearance, from what localStorage held. Before #198 it was `{ theme }`: "system", or one pinned theme,
 * which becomes the pick of its own kind with the mode pinned to that kind.
 */
export function parseAppearance(stored: unknown): Appearance {
  if (typeof stored !== "object" || stored === null) return DEFAULT_APPEARANCE;
  const listed: unknown = Reflect.get(stored, "custom");
  const custom = Array.isArray(listed) ? listed.filter(isCustomTheme) : [];
  const choices = themeChoices(custom);
  const pick = (id: string | undefined, light: boolean): string | undefined =>
    id !== undefined && choices.get(id)?.theme.light === light ? id : undefined;
  const base = {
    dark: pick(text(stored, "dark"), false) ?? DEFAULT_APPEARANCE.dark,
    light: pick(text(stored, "light"), true) ?? DEFAULT_APPEARANCE.light,
    density: DENSITIES.find((entry) => entry === text(stored, "density")) ?? DEFAULT_APPEARANCE.density,
    custom,
  };
  const mode = MODES.find((entry) => entry === text(stored, "mode"));
  if (mode !== undefined) return { ...base, mode };
  const legacy = text(stored, "theme");
  const pinned = legacy === undefined ? undefined : choices.get(legacy);
  if (legacy === "system") return { ...base, mode: "system" };
  if (legacy === undefined || pinned === undefined) return { ...base, mode: DEFAULT_APPEARANCE.mode };
  return pinned.theme.light ? { ...base, mode: "light", light: legacy } : { ...base, mode: "dark", dark: legacy };
}

/** The theme id on screen: the pinned kind's pick, or the system's when the mode is "system". */
export function activeThemeId(appearance: Appearance, systemDark: boolean): string {
  const dark = appearance.mode === "dark" || (appearance.mode === "system" && systemDark);
  return dark ? appearance.dark : appearance.light;
}

const customPaletteKeys = new WeakMap<CustomTheme, string | null>();

function customPaletteKey(entry: CustomTheme): string | null {
  if (customPaletteKeys.has(entry)) return customPaletteKeys.get(entry) ?? null;
  let key: string | null = null;
  try {
    const vars = themeVariables(resolveTheme(parseThemeFile(entry.file)));
    key = [
      vars["term-fg"] ?? "",
      vars["term-bg"] ?? "",
      vars["term-cursor"] ?? "",
      ...Array.from({ length: 16 }, (_, index) => vars[`term-color-${index}`] ?? ""),
    ].join("|");
  } catch {
    key = null;
  }
  customPaletteKeys.set(entry, key);
  return key;
}

/**
 * Identifies the active terminal palette for an appearance and system scheme: changes when the shown theme switches or
 * a custom theme in view changes its terminal colours, and stays equal across density or inactive-kind edits.
 */
export function activePaletteKey(appearance: Appearance, systemDark: boolean): string {
  const id = activeThemeId(appearance, systemDark);
  for (let index = appearance.custom.length - 1; index >= 0; index -= 1) {
    const entry = appearance.custom[index];
    if (entry === undefined || entry.id !== id) continue;
    const key = customPaletteKey(entry);
    if (key !== null) return `${id}:${key}`;
  }
  return id;
}
