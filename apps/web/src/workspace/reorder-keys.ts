import { normalizeTrigger, type Platform, triggerFromEvent, triggerKeys } from "../keys/trigger.ts";

/**
 * The keys that move a row of a sidebar list, the same chords that move a tab (#123): Cmd+Shift+Left/Right on macOS
 * (Up/Down too, the list being vertical), Ctrl+Shift+PageUp/PageDown elsewhere, Ghostty's own `move_tab`.
 */
const EARLIER: Readonly<Record<Platform, readonly string[]>> = {
  mac: ["super+shift+up", "super+shift+left"],
  other: ["ctrl+shift+page_up"],
};
const LATER: Readonly<Record<Platform, readonly string[]>> = {
  mac: ["super+shift+down", "super+shift+right"],
  other: ["ctrl+shift+page_down"],
};

/** In the keymap's canonical form (modifiers ordered ctrl, alt, shift, super), which is what a key event reads as. */
const canonical = (triggers: readonly string[]): readonly string[] =>
  triggers.flatMap((t) => normalizeTrigger(t) ?? []);

/** -1 moves the row up, 1 down; null when the key is not a move. */
export function reorderStep(
  event: Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">,
  platform: Platform,
): -1 | 1 | null {
  const trigger = triggerFromEvent(event);
  if (trigger === null) return null;
  if (canonical(EARLIER[platform]).includes(trigger)) return -1;
  if (canonical(LATER[platform]).includes(trigger)) return 1;
  return null;
}

/** The chips a row's menu shows beside Move up and Move down. */
export function reorderKeys(platform: Platform): { readonly up: readonly string[]; readonly down: readonly string[] } {
  const [up = "", down = ""] = [EARLIER[platform][0], LATER[platform][0]];
  return { up: triggerKeys(up, platform), down: triggerKeys(down, platform) };
}
