import type { HcConnection } from "@doriface/client";
import type { MachineView } from "@doriface/protocol";
import { graceEnds, graceViews, stepHeld, type Before, type Held } from "./machine-grace.ts";
import { orderMachines } from "./machines.ts";

/** One visible page reads each connection's machines every ten seconds, regardless of how many lists render them. */
export const MACHINE_REFRESH_MS = 10_000;

export interface MachineSnapshot {
  readonly views: readonly MachineView[];
  readonly heard: readonly MachineView[];
  readonly listError: string | undefined;
  readonly listed: number;
}

/** One machine.list history for the sidebar, settings and actions on the same connection. */
export class MachineSnapshots {
  readonly #connection: Pick<HcConnection, "call">;
  readonly #listeners = new Set<() => void>();
  #snapshot: MachineSnapshot = { views: [], heard: [], listError: undefined, listed: 0 };
  #before: Before = { views: [], at: undefined };
  #held: Held = new Map();
  #sent = 0;
  #applied = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  #expiry: ReturnType<typeof setTimeout> | undefined;

  constructor(connection: Pick<HcConnection, "call">) {
    this.#connection = connection;
  }

  getSnapshot = (): MachineSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) {
      void this.refresh();
      this.#timer = setInterval(this.#whenVisible, MACHINE_REFRESH_MS);
      document.addEventListener("visibilitychange", this.#whenVisible);
      this.#scheduleExpiry();
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size !== 0) return;
      clearInterval(this.#timer);
      clearTimeout(this.#expiry);
      document.removeEventListener("visibilitychange", this.#whenVisible);
    };
  };

  #whenVisible = (): void => {
    if (document.visibilityState === "visible") void this.refresh();
  };

  /** A terminal.run refusal is newer evidence than any list already in flight. */
  unavailable(machine: string): void {
    if (!this.#snapshot.heard.some((view) => view.name === machine && view.state === "connected")) return;
    this.#applied = ++this.#sent;
    const now = Date.now();
    this.#accept(
      this.#snapshot.heard.map((view) =>
        view.name === machine ? { ...view, state: "unreachable", since_ms: now } : view,
      ),
      now,
      this.#snapshot.listed,
    );
  }

  refresh = async (): Promise<void> => {
    const seq = ++this.#sent;
    try {
      const list = await this.#connection.call("machine.list");
      if (seq <= this.#applied) return;
      this.#applied = seq;
      this.#accept(orderMachines(list.machines), Date.now(), this.#snapshot.listed + 1);
    } catch (cause) {
      if (seq <= this.#applied) return;
      this.#applied = seq;
      this.#snapshot = {
        ...this.#snapshot,
        listError: cause instanceof Error ? cause.message : String(cause),
      };
      this.#publish();
    }
  };

  #accept(heard: readonly MachineView[], now: number, listed: number): void {
    this.#held = stepHeld(this.#held, this.#before, heard, now);
    const first = this.#before.first ?? { at: now, ids: new Set(heard.map((view) => view.id)) };
    const up = new Set(this.#before.up);
    for (const view of heard) if (view.state === "connected") up.add(view.id);
    this.#before = { views: heard, at: now, first, up };
    this.#snapshot = { views: graceViews(heard, this.#held, now), heard, listError: undefined, listed };
    this.#publish();
  }

  #publish(): void {
    this.#scheduleExpiry();
    for (const listener of this.#listeners) listener();
  }

  #scheduleExpiry(): void {
    clearTimeout(this.#expiry);
    if (this.#listeners.size === 0) return;
    const now = Date.now();
    const end = graceEnds(this.#held, now);
    if (end === undefined) return;
    this.#expiry = setTimeout(
      () => {
        this.#snapshot = {
          ...this.#snapshot,
          views: graceViews(this.#snapshot.heard, this.#held, Math.max(Date.now(), end)),
        };
        this.#publish();
      },
      Math.max(0, end - now),
    );
  }
}

const snapshots = new WeakMap<HcConnection, MachineSnapshots>();

export function machineSnapshots(connection: HcConnection): MachineSnapshots {
  const existing = snapshots.get(connection);
  if (existing !== undefined) return existing;
  const created = new MachineSnapshots(connection);
  snapshots.set(connection, created);
  return created;
}
