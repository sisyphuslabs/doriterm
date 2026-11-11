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

  /** Reads `machine.list` now; settles once this read's answer was applied or a later read's overtook it. */
  async refresh(): Promise<void> {
    this.#sent += 1;
    const seq = this.#sent;
    try {
      const list = await this.#list();
      if (seq <= this.#applied) return;
      this.#applied = seq;
      this.#apply(list.machines);
    } catch (cause) {
      if (seq <= this.#applied) return;
      this.#applied = seq;
      const error = cause instanceof Error ? cause.message : String(cause);
      this.#read = { ...this.#read, error };
      this.#changed(this.#read, []);
    }
  }

  #apply(listed: readonly MachineView[]): void {
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
    this.#changed(this.#read, diffMachines(before.views, views));
  }
}
