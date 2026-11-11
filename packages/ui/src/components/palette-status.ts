import type { Command } from "./command-palette.tsx";
import type { AgentStatus } from "./status.tsx";

/**
 * Most urgent first, as the sidebar's sections are ordered. An offline machine's agents (`unknown`) get no segment: there
 * is nothing to answer there until it is back.
 */
const ORDER: readonly AgentStatus[] = ["blocked", "working", "done", "idle"];
/**
 * With All, three segments: they fit a 320 px touch phone at its larger type with room for wider platform fonts (#1454),
 * and All still lists every agent.
 */
const MOST = 2;

export interface StatusCount {
  readonly status: AgentStatus;
  readonly count: number;
}

/**
 * The states the palette's agent rows are in, most urgent first and at most two, with how many rows are in each
 * (#1454). Empty unless at least two states differ: a filter over one state would filter nothing.
 */
export function statusCounts(commands: readonly Command[]): readonly StatusCount[] {
  const counts = ORDER.map((status) => ({
    status,
    count: commands.filter((command) => command.status === status).length,
  })).filter(({ count }) => count > 0);
  return counts.length < 2 ? [] : counts.slice(0, MOST);
}

/** How many agent rows there are: All's count, which a segment cap or an offline machine must not shrink. */
export function agentCount(commands: readonly Command[]): number {
  return commands.filter((command) => command.status !== undefined).length;
}

export function withStatus(commands: readonly Command[], status: AgentStatus | null): readonly Command[] {
  return status === null ? commands : commands.filter((command) => command.status === status);
}

/**
 * The chosen state while it is still one of the states shown. Once it is no longer shown, because no row is in it any more
 * or because more urgent states pushed it out of the two shown, every row shows again rather than a filter the person
 * cannot see or clear.
 */
export function shownStatus(counts: readonly StatusCount[], chosen: AgentStatus | null): AgentStatus | null {
  return counts.some(({ status }) => status === chosen) ? chosen : null;
}
