import type { LayoutTab } from "./layout-model.ts";

/**
 * The tabs a pending "Close tabs to the right" or "Close other tabs" still closes, read from the tabs as they are now:
 * one pinned since the set was chosen (on this device or another) is spared, and one already gone is skipped (#1561).
 */
export function stillClosing(tabs: readonly LayoutTab[], keys: readonly string[]): readonly LayoutTab[] {
  return tabs.filter((tab) => keys.includes(tab.key) && !tab.pinned);
}
