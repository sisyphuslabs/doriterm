import type { MachineListResult, MachineView } from "@doriface/protocol";
import { stepHeld, type Held } from "../workspace/machine-grace.ts";
import { orderMachines } from "../workspace/machines.ts";
import { diffMachines, type MachineChange } from "./changes.ts";

/** The machines as `machine.list` last said, with what the redial grace (#904) needs from the reads before. */
export interface MachinesRead {
  readonly views: readonly MachineView[];
  /** When the last answer was read (this page's clock); undefined before the first. */
  readonly at: number | undefined;
  readonly first?: { readonly at: number; readonly ids: ReadonlySet<string> };
  readonly up?: ReadonlySet<string>;
  readonly held: Held;
  /** How many answers have come back: a tab waits one read before taking a gone terminal as removed. */
  readonly listed: number;
  /** Why the last read failed, until one succeeds. */
  readonly error: string | undefined;
}

const UNREAD: MachinesRead = { views: [], at: undefined, held: new Map(), listed: 0, error: undefined };

/** Whether a read shows what the one before it showed: the same machines as listed, the same grace, no error either side. */
function unchanged(before: MachinesRead, after: MachinesRead): boolean {
  if (before.error !== undefined || after.error !== undefined || before.held.size !== after.held.size) return false;
  for (const [id, since] of after.held) if (before.held.get(id) !== since) return false;
  return JSON.stringify(before.views) === JSON.stringify(after.views);
}

/**
 * The one reader of `machine.list` for a core. Each read is numbered when sent and an answer applies unless a
 * later-sent read's answer was already applied, so an answer slower than the next read still draws and an old answer
 * never overwrites a newer one. Every applied answer is diffed against the one before by permanent machine id.
 */
export class MachineRoster {
  readonly #list: () => Promise<MachineListResult>;
  readonly #changed: (read: MachinesRead, changes: readonly MachineChange[]) => void;
  readonly #now: () => number;
  #read: MachinesRead = UNREAD;
  #sent = 0;
  #applied = 0;

  constructor(
    list: () => Promise<MachineListResult>,
    changed: (read: MachinesRead, changes: readonly MachineChange[]) => void,
    now: () => number = Date.now,
  ) {
    this.#list = list;
    this.#changed = changed;
    this.#now = now;
  }

  get read(): MachinesRead {
    return this.#read;
  }

  /**
   * Reads `machine.list` now; settles once this read's answer was applied or a later read's overtook it. A `quiet` read
   * (the line read, every second) that changes nothing is kept without telling anyone, so it re-renders nothing (#2184);
   * every other read is told, changed or not, since a read count moving on is what some checks wait for.
   */
  async refresh(quiet = false): Promise<void> {
    this.#sent += 1;
    const seq = this.#sent;
    try {
      const list = await this.#list();
      if (seq <= this.#applied) return;
      this.#applied = seq;
      this.#apply(list.machines, quiet);
    } catch (cause) {
      if (seq <= this.#applied) return;
      this.#applied = seq;
      const error = cause instanceof Error ? cause.message : String(cause);
      const same = quiet && error === this.#read.error;
      this.#read = { ...this.#read, error };
      if (!same) this.#changed(this.#read, []);
    }
  }

  #apply(listed: readonly MachineView[], quiet: boolean): void {
    const before = this.#read;
    const at = this.#now();
    const views = orderMachines(listed);
    const first = before.first ?? { at, ids: new Set(views.map((view) => view.id)) };
    const up = new Set(before.up);
    for (const view of views) if (view.state === "connected") up.add(view.id);
    this.#read = {
      views,
      at,
      first,
      up,
      held: stepHeld(before.held, before, views, at),
      listed: before.listed + 1,
      error: undefined,
    };
    if (quiet && unchanged(before, this.#read)) return;
    this.#changed(this.#read, diffMachines(before.views, views));
  }
}
