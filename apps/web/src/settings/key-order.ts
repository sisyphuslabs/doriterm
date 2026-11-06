import type { KeyBarSettings } from "../keybar/settings.ts";

/**
 * Places the visible keys in the order given, into the slots they already occupy. A key this host hides keeps its slot, so
 * a move never depends on the drawn list and the stored list agreeing: on a host without a Command key the stored list
 * still holds `cmd`, and a plain index would move a key one place too far.
 */
export function inVisibleOrder(current: KeyBarSettings, ordered: readonly string[]): KeyBarSettings {
  const keys = [...current.keys];
  let next = 0;
  for (let at = 0; at < keys.length && next < ordered.length; at += 1) {
    const id = keys[at] ?? "";
    if (ordered.includes(id)) {
      keys[at] = ordered[next] ?? id;
      next += 1;
    }
  }
  return { ...current, keys };
}
