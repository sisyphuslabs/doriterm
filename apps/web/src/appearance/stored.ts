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
