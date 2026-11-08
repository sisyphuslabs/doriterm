import type { Command } from "./command-palette.tsx";
import type { AgentStatus } from "./status.tsx";

/**
 * Most urgent first, as the sidebar's sections are ordered. An offline machine's agents (`unknown`) get no segment: there
 * is nothing to answer there until it is back.
 */
const ORDER: readonly AgentStatus[] = ["blocked", "working", "done", "idle"];
/** With All, at most four segments: DESIGN.md's limit for a segmented control. */
const MOST = 3;

export interface StatusCount {
  readonly status: AgentStatus;
  readonly count: number;
}

/**
 * The states the palette's agent rows are in, most urgent first and at most three, with how many rows are in each
 * (#1454). Empty unless at least two states differ: a filter over one state would filter nothing.
 */
export function statusCounts(commands: readonly Command[]): readonly StatusCount[] {
  const counts = ORDER.map((status) => ({
    status,
    count: commands.filter((command) => command.status === status).length,
  })).filter(({ count }) => count > 0);
  return counts.length < 2 ? [] : counts.slice(0, MOST);
}

export function withStatus(commands: readonly Command[], status: AgentStatus | null): readonly Command[] {
  return status === null ? commands : commands.filter((command) => command.status === status);
}

/** The chosen state while some row is still in it; once none is, every row shows again rather than an empty list. */
export function shownStatus(counts: readonly StatusCount[], chosen: AgentStatus | null): AgentStatus | null {
  return counts.some(({ status }) => status === chosen) ? chosen : null;
}
