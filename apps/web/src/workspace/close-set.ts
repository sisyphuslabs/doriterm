import { useEffect, useState } from "react";
import type { LayoutTab } from "./layout-model.ts";

/**
 * The tabs a pending "Close tabs to the right" or "Close other tabs" still closes, read from the tabs as they are now:
 * one pinned since the set was chosen (on this device or another) is spared, and one already gone is skipped (#1561).
 */
export function stillClosing(tabs: readonly LayoutTab[], keys: readonly string[]): readonly LayoutTab[] {
  return tabs.filter((tab) => keys.includes(tab.key) && !tab.pinned);
}

export interface CloseSet {
  /** The tabs the pending question still closes; none means no question is up. */
  readonly closing: readonly LayoutTab[];
  /** Identity of the chosen set, so a new set opens a new question. */
  readonly key: string;
  readonly open: (keys: readonly string[]) => void;
  readonly done: () => void;
}

/**
 * The pending "Close tabs to the right" or "Close other tabs" question. A set left with nothing to close, because its
 * tabs were pinned or closed meanwhile, is forgotten: without that the question comes back when one is unpinned (#1916).
 */
export function useCloseSet(tabs: readonly LayoutTab[]): CloseSet {
  const [keys, setKeys] = useState<readonly string[]>([]);
  const closing = stillClosing(tabs, keys);
  const empty = closing.length === 0;
  useEffect(() => {
    if (empty) setKeys((chosen) => (chosen.length === 0 ? chosen : []));
  }, [empty]);
  return { closing, key: keys.join(" "), open: setKeys, done: () => setKeys([]) };
}
