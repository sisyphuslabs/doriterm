import { setDesktopMenuKeys } from "../desktop/bridge.ts";
import type { Keymap } from "./defaults.ts";
import { resolveKeymap, triggersFor } from "./keymap.ts";
import { keymapStore, type KeymapStore } from "./keymap-store.ts";
import { currentPlatform } from "./trigger.ts";

/** The actions the desktop app's Shell menu lists (apps/desktop/src/main/shell-menu.ts). */
export const MENU_ACTIONS: readonly string[] = [
  "tab.new",
  "tab.rename",
  "pane.split:right",
  "pane.split:down",
  "pane.go:left",
  "pane.go:right",
  "pane.go:up",
  "pane.go:down",
  "pane.swap:left",
  "pane.swap:right",
  "pane.swap:up",
  "pane.swap:down",
  "pane.resize:left",
  "pane.resize:right",
  "pane.resize:up",
  "pane.resize:down",
  "pane.equalize",
  "pane.zoom",
  "pane.close",
  "tab.close",
  ...Array.from({ length: 9 }, (_, index) => `space.select:${index + 1}`),
  "space.prev",
  "space.next",
  "space.new",
];

/** The first trigger bound to each menu action; an unbound one is left out, so its item shows no shortcut. */
export function menuKeys(keymap: Keymap): Record<string, string> {
  return Object.fromEntries(
    MENU_ACTIONS.flatMap((action) => {
      const [trigger] = triggersFor(keymap, action);
      return trigger === undefined ? [] : [[action, trigger]];
    }),
  );
}

export function reportMenuKeys(store: KeymapStore = keymapStore): () => void {
  const report = (): void => setDesktopMenuKeys(menuKeys(resolveKeymap(currentPlatform(), store.overrides)));
  report();
  return store.subscribe(report);
}
