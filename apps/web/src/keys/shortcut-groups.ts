import type { ShortcutGroup } from "@doriface/ui";
import { ACTIONS, actionFor, SCOPE_LABEL, type ActionDef } from "./actions.ts";
import type { Keymap } from "./defaults.ts";
import { triggersFor } from "./keymap.ts";
import { triggerKeys, type Platform } from "./trigger.ts";

/**
 * The keymap in force as the shortcuts dialog lists it: App then Terminal, as Settings > Keybindings groups them, every
 * action with at least one key and every chord bound to it. Bound `send:` text follows the terminal's own actions.
 */
export function shortcutGroups(keymap: Keymap, platform: Platform): ShortcutGroup[] {
  const sends = [...new Set(keymap.values())]
    .filter((id) => id.startsWith("send:"))
    .map(actionFor)
    .filter((action): action is ActionDef => action !== null);
  const actions = [...ACTIONS, ...sends];
  return (["app", "terminal"] as const).flatMap((scope) => {
    const rows = actions
      .filter((action) => action.scope === scope)
      .map((action) => ({
        id: action.id,
        label: action.label,
        chords: triggersFor(keymap, action.id).map((trigger) => triggerKeys(trigger, platform)),
      }))
      .filter((row) => row.chords.length > 0);
    return rows.length === 0 ? [] : [{ title: SCOPE_LABEL[scope], rows }];
  });
}
