import type { HcConnection } from "@doriface/client";
import { type Roster, rosterFor } from "../roster/roster.ts";

/** hc's states for an added machine whose line is down and being redialed. */
const DOWN = new Set(["connecting", "unreachable"]);

type Changed = (connection: HcConnection) => void;

/** What machine lines need of a core's roster: its reads, and its line read (roster/line-watch.ts). */
type LineRoster = Pick<Roster, "subscribe" | "snapshot" | "watchLines">;

/**
 * Each connection's added machines by name, as the core's roster last read them, for the views that write to them. The
 * roster is the one reader of machine.list (#2056): a view that watches a line has the roster read it every second.
 */
export class MachineLines {
  readonly #states = new WeakMap<HcConnection, ReadonlyMap<string, string>>();
  readonly #listeners = new Set<Changed>();
  readonly #rosterOf: (connection: HcConnection) => LineRoster;

  constructor(rosterOf: (connection: HcConnection) => LineRoster = rosterFor) {
    this.#rosterOf = rosterOf;
  }

  /** The machine's line is down on that connection's core, as last read: what is written to its terminals is lost. */
  down(connection: HcConnection, machine: string): boolean {
    return DOWN.has(this.#states.get(connection)?.get(machine) ?? "");
  }

  heard(connection: HcConnection, machines: readonly { readonly name: string; readonly state: string }[]): void {
    const before = this.#states.get(connection);
    const now = new Map(machines.map((machine) => [machine.name, machine.state]));
    this.#states.set(connection, now);
    const changed = before?.size !== now.size || [...now].some(([name, state]) => before.get(name) !== state);
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
