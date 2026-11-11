import type { ListResult, Terminal } from "@doriface/protocol";

export interface TerminalsState {
  readonly terminals: readonly Terminal[];
  /** False until the core's first answer: an empty list before it means unknown, not none. */
  readonly loaded: boolean;
  readonly machines: number;
  readonly error: string | null;
}

export const NO_TERMINALS: TerminalsState = { terminals: [], loaded: false, machines: 0, error: null };

/** hc 0.1.17 leaves machines out of terminal.list answers when it has none, so absent counts as none. */
export function machineCount(list: Pick<ListResult, "machines">): number {
  return list.machines?.length ?? 0;
}
