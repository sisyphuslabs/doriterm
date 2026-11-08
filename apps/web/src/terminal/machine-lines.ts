import type { HcConnection } from "@doriface/client";

/** hc's states for an added machine whose line is down and being redialed. */
const DOWN = new Set(["connecting", "unreachable"]);

/**
 * How often machine.list is read while a terminal on an added machine is in view. hc sends no event when a machine's line
 * drops or comes back, and it drops what is written to that machine's terminals meanwhile while keeping their streams
 * open (#1489), so this read is how a view learns to hold its input. Keys typed between the drop and the next read are
 * still lost (an hc gap); a read a second keeps that window short for one small call a second, only while it matters.
 */
export const LINE_READ_MS = 1000;

type Changed = (connection: HcConnection) => void;

interface Watch {
  count: number;
  timer: ReturnType<typeof setInterval>;
  reading: boolean;
}

/** The page is visible: keys are typed only then, and a hidden page reads nothing. */
const pageVisible = (): boolean => typeof document === "undefined" || document.visibilityState === "visible";

/** Each connection's added machines by name, as its last machine.list read said, for the views that write to them. */
export class MachineLines {
  readonly #states = new WeakMap<HcConnection, ReadonlyMap<string, string>>();
  readonly #watches = new Map<HcConnection, Watch>();
  readonly #listeners = new Set<Changed>();
  readonly #visible: () => boolean;

  constructor(visible: () => boolean = pageVisible) {
    this.#visible = visible;
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

  /** Reads machine.list on the connection now and every LINE_READ_MS until every watcher stopped; returns the stop. */
  watch(connection: HcConnection): () => void {
    const existing = this.#watches.get(connection);
    const watch = existing ?? {
      count: 0,
      timer: setInterval(() => this.#read(connection), LINE_READ_MS),
      reading: false,
    };
    watch.count += 1;
    this.#watches.set(connection, watch);
    if (existing === undefined) this.#read(connection);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      watch.count -= 1;
      if (watch.count > 0) return;
      clearInterval(watch.timer);
      this.#watches.delete(connection);
    };
  }

  /** One read at a time, so answers apply in the order sent. A failed read changes nothing: the link's own status says why. */
  #read(connection: HcConnection): void {
    const watch = this.#watches.get(connection);
    if (watch === undefined || watch.reading || connection.closed || !this.#visible()) return;
    watch.reading = true;
    connection.call("machine.list").then(
      (list) => {
        watch.reading = false;
        this.heard(connection, list.machines);
        return list;
      },
      () => {
        watch.reading = false;
      },
    );
  }
}

/** The app's one view of its machines' lines: terminal views hold input by it. */
export const machineLines = new MachineLines();
