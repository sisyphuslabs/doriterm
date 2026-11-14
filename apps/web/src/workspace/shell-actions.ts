export type Shell = "desktop" | "phone";

/** An app action the palette lists; `unavailable` says why it cannot run right now. */
export interface ShellAction {
  readonly id: string;
  readonly unavailable?: string;
}

/**
 * The app actions each shell's palette may offer; that shell's handler takes every one of them. Resize is not offered:
 * one step moves a line a twentieth, so it is left to its keys, the divider's own keys and the Shell menu.
 */
const SHELL_ACTIONS: Readonly<Record<Shell, readonly string[]>> = {
  desktop: [
    "tab.new",
    "pane.split:right",
    "pane.split:down",
    "pane.close",
    "pane.swap:left",
    "pane.swap:right",
    "pane.swap:up",
    "pane.swap:down",
    "pane.equalize",
    "pane.zoom",
    "agent.waiting",
    "tab.close",
    "tab.rename",
    "tab.move:left",
    "tab.move:right",
    "session.rename",
    "session.end",
    "space.rename",
    // herdr-app's palette lists the space cycle keys; a space's number chords select what a person points at, which
    // herdr's palette hides `space.select` for the same reason.
    "space.next",
    "space.prev",
    "space.new",
    "voice.dictate",
    "terminal.search",
    "layout.toggle:sidebar",
    "layout.filter:sidebar",
    "app.zoom_in",
    "app.zoom_out",
    "app.help",
    "app.settings",
  ],
  phone: [
    "tab.new",
    "session.rename",
    "session.end",
    "space.rename",
    "voice.dictate",
    "terminal.search",
    "app.zoom_in",
    "app.zoom_out",
    "app.help",
    "app.settings",
  ],
};

/** Actions on the session in view: rename, end, dictating into it, finding in it, and renaming its space. */
const SESSION_ACTIONS = new Set(["session.rename", "session.end", "voice.dictate", "terminal.search", "space.rename"]);

/** The strip's tab keys in order, and the selected tab's: what moving a tab is measured against. */
export interface Strip {
  readonly keys: readonly string[];
  readonly active: string | null;
}

const NO_STRIP: Strip = { keys: [], active: null };

/** Whether the active tab has a neighbour on that side to move past. */
function canMove(id: string, { keys, active }: Strip): boolean {
  const at = active === null ? -1 : keys.indexOf(active);
  if (at === -1) return false;
  return id === "tab.move:left" ? at > 0 : at < keys.length - 1;
}

/**
 * Splitting needs a terminal in view whose layout takes edits, and renaming its space a layout that takes edits; until
 * then each is listed as unavailable, with why. New tab waits only while its machine is offline (`newWhy`): a reachable
 * machine whose layout takes no edits still starts a terminal (#2569).
 */
function unavailable(id: string, inView: boolean, readOnly: string | null, newWhy: string | null): string | undefined {
  if (id === "tab.new") return newWhy ?? undefined;
  if (id === "space.rename" || id === "tab.rename") return readOnly ?? undefined;
  if (!id.startsWith("pane.split:")) return undefined;
  return inView ? (readOnly ?? undefined) : "No terminal to split";
}

/**
 * What the palette lists right now. Rename and End session apply to the session in view, so with none in view they
 * are left out, as a palette leaves out commands that do not apply, and so is moving the active tab past an end of the
 * strip, and opening the next agent that needs you while nobody does (`waiting`); Split is listed as unavailable until
 * it can run.
 */
export function availableActions(
  shell: Shell,
  inView: boolean,
  readOnly: string | null = null,
  strip: Strip = NO_STRIP,
  waiting = false,
  /** Why New tab waits (its machine is offline), or null while it is offered. */
  newWhy: string | null = null,
): readonly ShellAction[] {
  return SHELL_ACTIONS[shell]
    .filter((id) => inView || !SESSION_ACTIONS.has(id))
    .filter((id) => id !== "agent.waiting" || waiting)
    .filter((id) => !id.startsWith("tab.move:") || canMove(id, strip))
    .map((id) => {
      const reason = unavailable(id, inView, readOnly, newWhy);
      return reason === undefined ? { id } : { id, unavailable: reason };
    });
}
