import {
  BUILTIN_PALETTES,
  BUILTIN_THEMES,
  isBuiltinThemeName,
  parseThemeFile,
  resolveTheme,
  type ResolvedTheme,
} from "@doriface/ui";

export interface CustomTheme {
  readonly id: string;
  readonly name: string;
  /** The herdr-app theme file as imported, so it re-resolves with newer rules. */
  readonly file: unknown;
}

export interface ThemeChoice {
  readonly name: string;
  /** Where the theme comes from, with its licence for a library theme. */
  readonly source: string;
  readonly theme: ResolvedTheme;
}

const BUILTINS: ReadonlyMap<string, ThemeChoice> = new Map(
  Object.keys(BUILTIN_PALETTES)
    .filter(isBuiltinThemeName)
    .map((id) => {
      const info = BUILTIN_THEMES[id];
      const source = info.licence === undefined ? info.family : `${info.family} · ${info.licence}`;
      return [id, { name: info.name, source, theme: resolveTheme(BUILTIN_PALETTES[id]) }];
    }),
);

/** Every selectable theme resolved, built-ins first; custom files that no longer parse are skipped. */
export function themeChoices(custom: readonly CustomTheme[]): ReadonlyMap<string, ThemeChoice> {
  const choices = new Map(BUILTINS);
  for (const entry of custom) {
    let theme: ResolvedTheme;
    try {
      theme = resolveTheme(parseThemeFile(entry.file));
    } catch {
      continue;
    }
    choices.set(entry.id, { name: entry.name, source: "herdr-app file", theme });
  }
  return choices;
}
