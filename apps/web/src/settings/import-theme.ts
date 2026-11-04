import { parseThemeFile, resolveTheme } from "@doriface/ui";
import { type Appearance, appearanceStore } from "../appearance/appearance.ts";

/** Validates a herdr-app theme file, stores it and selects it as the pick of its kind, shown at once. */
export async function importThemeFile(file: File, appearance: Appearance): Promise<void> {
  const json: unknown = JSON.parse(await file.text());
  const kind = resolveTheme(parseThemeFile(json)).light ? "light" : "dark";
  const name = file.name.replace(/\.json$/i, "");
  const id = `custom:${name}`;
  const custom = [...appearance.custom.filter((entry) => entry.id !== id), { id, name, file: json }];
  appearanceStore.update({ custom, [kind]: id, mode: kind });
}
