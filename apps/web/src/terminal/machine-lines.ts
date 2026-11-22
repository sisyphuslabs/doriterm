import type { HcConnection } from "@doriface/client";
import type { MachineView } from "@doriface/protocol";
import { type Roster, rosterFor } from "../roster/roster.ts";

/** hc's states for an added machine whose line is down and being redialed. */
const DOWN = new Set(["connecting", "unreachable"]);

type Changed = (connection: HcConnection) => void;

/** What machine lines keep of a machine as the roster read it: its state, and hc's words for why it is down. */
type Line = Pick<MachineView, "name" | "state" | "why">;

/** What machine lines need of a core's roster: its reads, and its line read (roster/line-watch.ts). */
type LineRoster = Pick<Roster, "subscribe" | "snapshot" | "watchLines">;

/**
 * Each connection's added machines by name, as the core's roster last read them, for the views that write to them. The
 * roster is the one reader of machine.list (#2056): a view that watches a line has the roster read it every second.
 */
export class MachineLines {
  readonly #lines = new WeakMap<HcConnection, ReadonlyMap<string, Line>>();
  /** When (this page's clock) each machine's line was first read down, while it stays down. */
  readonly #downSince = new WeakMap<HcConnection, ReadonlyMap<string, number>>();
  readonly #listeners = new Set<Changed>();
  readonly #rosterOf: (connection: HcConnection) => LineRoster;

  readonly #now: () => number;

  constructor(rosterOf: (connection: HcConnection) => LineRoster = rosterFor, now: () => number = Date.now) {
    this.#rosterOf = rosterOf;
    this.#now = now;
  }

  /** The machine's line is down on that connection's core, as last read: what is written to its terminals is lost. */
  down(connection: HcConnection, machine: string): boolean {
    return DOWN.has(this.#lines.get(connection)?.get(machine)?.state ?? "");
  }

  /** When this page first read the machine's line down, while it is down; undefined while it is up. */
  downSince(connection: HcConnection, machine: string): number | undefined {
    return this.#downSince.get(connection)?.get(machine);
  }

  /** The machine as the roster last read it, with hc's `why`; undefined while it is not listed. */
  line(connection: HcConnection, machine: string): Line | undefined {
    return this.#lines.get(connection)?.get(machine);
  }

  heard(connection: HcConnection, machines: readonly Line[]): void {
    const before = this.#lines.get(connection);
    const now = new Map(machines.map((machine) => [machine.name, machine]));
    this.#lines.set(connection, now);
    const was = this.#downSince.get(connection);
    const at = this.#now();
    const since = new Map<string, number>();
    for (const [name, line] of now) if (DOWN.has(line.state)) since.set(name, was?.get(name) ?? at);
    this.#downSince.set(connection, since);
    const changed =
      before?.size !== now.size ||
      [...now].some(([name, line]) => before.get(name)?.state !== line.state || before.get(name)?.why !== line.why);
    if (changed) for (const listener of this.#listeners) listener(connection);
  }

  subscribe(listener: Changed): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Takes the lines from the connection's roster, which reads them every second until every watcher stopped. */
  watch(connection: HcConnection): () => void {
    const roster = this.#rosterOf(connection);
    const read = (): void => this.heard(connection, roster.snapshot.machines.views);
    const unsubscribe = roster.subscribe(read);
    const unwatch = roster.watchLines();
    read();
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      unwatch();
      unsubscribe();
    };
  }
}

/** The app's one view of its machines' lines: terminal views hold input by it. */
export const machineLines = new MachineLines();
