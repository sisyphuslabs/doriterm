import type { MachineView, Terminal } from "@doriface/protocol";
import { machineOf, type Session } from "./model.ts";

/** The machine states whose terminals read offline: the status line and the panes read this one set. */
export const AWAY: ReadonlySet<string> = new Set(["unreachable", "needs_login"]);

/** Each terminal's offline copy, so a terminal that did not change stays the same object from render to render (#2086). */
const offlineCopies = new WeakMap<Terminal, Session>();

function offline(terminal: Terminal): Session {
  const known = offlineCopies.get(terminal);
  if (known !== undefined) return known;
  const copy: Session = { ...terminal, offline: true };
  offlineCopies.set(terminal, copy);
  return copy;
}

/**
 * Marks the live terminals of every added machine that is unreachable or needs a login as offline; a machine that is
 * only redialing (connecting) keeps them as they are, so a routine redial raises no alarm. hc sends no event when a
 * machine's line drops: its terminals stay live in the feed while machine.list already says unreachable, so the
 * machine's state decides. Terminals of machines missing from the list (not read yet) stay as they are.
 */
export function withReach(terminals: readonly Terminal[], machines: readonly MachineView[]): readonly Session[] {
  const away = new Set(machines.filter((machine) => AWAY.has(machine.state)).map((machine) => machine.name));
  if (away.size === 0) return terminals;
  return terminals.map((terminal) => {
    const machine = machineOf(terminal.address);
    const cut = terminal.state === "live" && machine !== undefined && away.has(machine);
    return cut ? offline(terminal) : terminal;
  });
}
