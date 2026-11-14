import type { ListResult, Terminal } from "@doriface/protocol";

/** What a terminal shows rather than what it is: its title, and what runs in front of it short of where (#2607). */
const SHOWN: ReadonlySet<string> = new Set(["title", "foreground"]);

/** Whether two entries of one terminal differ only in what it shows; its foreground's directory places it in a space. */
function sameTerminalShape(a: Terminal, b: Terminal): boolean {
  if (a === b) return true;
  if (((a.foreground ?? null) === null) !== ((b.foreground ?? null) === null)) return false;
  if (a.foreground?.cwd !== b.foreground?.cwd) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (!SHOWN.has(key) && Reflect.get(a, key) !== Reflect.get(b, key)) return false;
  }
  return true;
}

/**
 * Whether two states hold the same terminals in the same order and differ only in what they show, so a surface that
 * reads the list (spaces, tabs, panes, machines) has nothing to draw again; what a terminal shows is read per terminal.
 */
export function sameShape(a: TerminalsState, b: TerminalsState): boolean {
  if (a.loaded !== b.loaded || a.machines !== b.machines || a.error !== b.error) return false;
  if (a.terminals.length !== b.terminals.length) return false;
  return a.terminals.every((terminal, index) => {
    const other = b.terminals[index];
    return other !== undefined && sameTerminalShape(terminal, other);
  });
}

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
