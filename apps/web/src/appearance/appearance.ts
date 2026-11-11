import { themeVariables } from "@doriface/ui";
import { useSyncExternalStore } from "react";
import { themeChoices } from "./choices.ts";
import { activeThemeId, parseAppearance, type Appearance } from "./stored.ts";
import { guardedLocalStorage } from "../storage/guarded.ts";

export { themeChoices } from "./choices.ts";
export type { Appearance, AppearanceMode, Density } from "./stored.ts";

const KEY = "doriface.appearance";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/** The stored appearance; storage that refuses the read (site settings, a sandbox) or holds junk gives the defaults. */
function load(): Appearance {
  let stored: unknown;
  try {
    stored = JSON.parse(guardedLocalStorage().getItem(KEY) ?? "null");
  } catch {
    stored = null;
  }
  return parseAppearance(stored);
}

const systemDark = (): boolean => matchMedia(DARK_QUERY).matches;

/**
 * Writes the theme on screen as variables onto <html>, so the UI and every terminal re-theme without a reload, and the
 * density as `data-ui-density`, which tokens.css turns into row heights.
 */
export function applyAppearance(
  appearance: Appearance,
  root: HTMLElement = document.documentElement,
  dark: boolean = systemDark(),
): void {
  root.dataset["uiDensity"] = appearance.density;
  for (const name of Array.from(root.style)) if (name.startsWith("--")) root.style.removeProperty(name);
  root.style.removeProperty("color-scheme");
  const choice = themeChoices(appearance.custom).get(activeThemeId(appearance, dark));
  if (choice === undefined) return;
  for (const [name, value] of Object.entries(themeVariables(choice.theme))) root.style.setProperty(`--${name}`, value);
  root.style.setProperty("color-scheme", choice.theme.light ? "light" : "dark");
  // Every theme-color meta (the page starts with one): the theme in view already accounts for the system scheme and the user's pick.
  for (const meta of root.ownerDocument.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))
    meta.content = choice.theme.roles.chrome;
}

class AppearanceStore {
  #value = load();
  #listeners = new Set<() => void>();
  get value(): Appearance {
    return this.#value;
  }
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  update(patch: Partial<Appearance>): void {
    this.#value = { ...this.#value, ...patch };
    guardedLocalStorage().setItem(KEY, JSON.stringify(this.#value));
    applyAppearance(this.#value);
    for (const listener of this.#listeners) listener();
  }
}

export const appearanceStore = new AppearanceStore();

/** Applies the stored appearance now and again whenever the system switches between light and dark. */
export function startAppearance(): void {
  applyAppearance(appearanceStore.value);
  matchMedia(DARK_QUERY).addEventListener("change", () => applyAppearance(appearanceStore.value));
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(appearanceStore.subscribe, () => appearanceStore.value);
}
