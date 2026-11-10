import type { AgentStatus } from "@doriface/ui";
import { agentStatus, type Session } from "./attention.ts";

/**
 * How long an agent's turn between Working and Idle has to hold before its row moves to the other group (#1949). An
 * agent whose only live work is a watch idles between the turns each firing starts, so without the wait its row, and
 * every row below it, jumped a row up or down several times a minute. The glyph on the row still shows the live state.
 */
export const SETTLE_MS = 15_000;

/** Where an agent's row is listed, and since when the agent has been in a state that would list it elsewhere. */
export interface AgentPlace {
  readonly status: AgentStatus;
  readonly pending?: { readonly status: AgentStatus; readonly sinceMs: number };
}

export type AgentPlaces = ReadonlyMap<string, AgentPlace>;

/**
 * Only a turn ending without a finish waits: Working to an Idle the agent reported. Starting work, Needs you, Done, a
 * finish this screen has seen (it reads Idle) and a machine that went away move the row at once. A watch agent's idle
 * gap between firings is then absorbed by the wait, which its next Working cancels.
 */
const waits = (before: AgentStatus, live: AgentStatus, terminal: Session): boolean =>
  before === "working" && live === "idle" && terminal.state === "live" && terminal.status?.state !== "done";

/**
 * Each live agent's place for the status groups, carried over from `previous`: a row moves at once unless an agent's
 * turn ends in Idle without a finish, which moves it only once Idle has held `SETTLE_MS`. `due` is
 * when the next pending move falls due, or null when none is waiting. Returns `previous` itself when nothing changed.
 */
export function placeAgents(
  previous: AgentPlaces,
  terminals: readonly Session[],
  nowMs: number,
): { readonly places: AgentPlaces; readonly due: number | null } {
  const places = new Map<string, AgentPlace>();
  let changed = false;
  let due: number | null = null;
  for (const terminal of terminals) {
    if (terminal.state !== "live") continue;
    const live = agentStatus(terminal);
    const before = previous.get(terminal.address);
    const next = place(before, live, nowMs, before !== undefined && waits(before.status, live, terminal));
    if (next.pending !== undefined) {
      const at = next.pending.sinceMs + SETTLE_MS;
      due = due === null ? at : Math.min(due, at);
    }
    if (before === undefined || before.status !== next.status || before.pending !== next.pending) changed = true;
    places.set(terminal.address, next);
  }
  if (places.size !== previous.size) changed = true;
  return { places: changed ? places : previous, due };
}

function place(before: AgentPlace | undefined, live: AgentStatus, nowMs: number, wait: boolean): AgentPlace {
  if (before === undefined || before.status === live || !wait) {
    return before !== undefined && before.status === live && before.pending === undefined ? before : { status: live };
  }
  const pending = before.pending?.status === live ? before.pending : { status: live, sinceMs: nowMs };
  if (nowMs - pending.sinceMs >= SETTLE_MS) return { status: live };
  return before.pending === pending ? before : { status: before.status, pending };
}
