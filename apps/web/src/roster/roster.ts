import type { HcConnection } from "@doriface/client";
import type { HcEvent } from "@doriface/protocol";
import {
  type DocState,
  LAYOUT_DOC,
  LayoutDoc,
  ORDER_DOC,
  PINS_DOC,
  readOrderDocument,
  readPinsDocument,
} from "@doriface/protocol/layout";
import { machineKey } from "../workspace/machines.ts";
import type { RosterChange } from "./changes.ts";
import { docCalls } from "./doc-calls.ts";
import { LayoutDocs } from "./docs.ts";
import { RosterFeed, type Schedule } from "./feed.ts";
import type { RosterLink } from "./link.ts";
import { MachineRoster, type MachinesRead } from "./machines.ts";
import { NO_TERMINALS, type TerminalsState } from "./terminals-state.ts";

/**
 * hc sends no event when a machine's line comes up, drops or wants a login; `missed` covers a line that comes or goes
 * with the feed, and the terminals a line brings or takes cover the rest, except a line that drops with no terminals on
 * it. machine.list is read on this timer while the page is visible for that case: hc redials within 250 ms to 30 s and
 * one machine.list is a few hundred bytes, so every 10 s keeps that stale state shorter than it takes to notice.
 */
export const MACHINE_REFRESH_MS = 10_000;

export interface RosterSnapshot {
  readonly terminals: TerminalsState;
  readonly machines: MachinesRead;
  /** This core's machine order document (`doriface`). */
  readonly order: DocState;
  /** Counts layout documents landing: readers take each document's state from `roster.docs` as they render. */
  readonly docsLanded: number;
}

/** A `doc` event as the feed carried it: which machine's document (null for this core's), its name and version. */
export type DocHeard = (machine: string | null, name: string, version: number) => void;

export interface RosterOptions {
  readonly schedule?: Schedule;
  readonly every?: (run: () => void, ms: number) => () => void;
  readonly visible?: () => boolean;
  readonly whenVisible?: (run: () => void) => () => void;
  readonly now?: () => number;
}

const browser = {
  every: (run: () => void, ms: number): (() => void) => {
    const timer = setInterval(run, ms);
    return () => clearInterval(timer);
  },
  visible: (): boolean => typeof document === "undefined" || document.visibilityState === "visible",
  whenVisible: (run: () => void): (() => void) => {
    if (typeof document === "undefined") return () => undefined;
    const listener = (): void => {
      if (document.visibilityState === "visible") run();
    };
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
};

/**
 * The one source of a core's roster for every surface: its terminals, its machines and their layout documents, and its
 * machine order, fed by one `events.subscribe` and read again on every gap. It outlives a connection: a reconnect to
 * the same core attaches the new one, keeps what the screen shows, and diffs the fresh reads against it, so a machine
 * or a space is never shown twice and never dropped for a redial. hc has no event for a machine's line (schema
 * 0.1.17 lists none), so `missed` (which hc sends when a line comes or goes) and the terminals a line brings drive the
 * reads, with one timer as the fallback for a line that drops with no terminals on it.
 */
export class Roster {
  readonly machines: MachineRoster;
  readonly docs: LayoutDocs;
  readonly pins: LayoutDocs;
  readonly order: LayoutDoc;
  readonly #options: RosterOptions;
  readonly #listeners = new Set<() => void>();
  readonly #changes = new Set<(change: RosterChange) => void>();
  readonly #docHeard = new Set<DocHeard>();
  readonly #gaps = new Set<() => void>();
  #connection: RosterLink;
  #feed: RosterFeed | undefined;
  #snapshot: RosterSnapshot;
  #key: string | undefined;
  #stops: (() => void)[] = [];

  constructor(connection: RosterLink, options: RosterOptions = {}) {
    this.#connection = connection;
    this.#options = options;
    const call: RosterLink["call"] = (method, ...args) => this.#connection.call(method, ...args);
    this.machines = new MachineRoster(
      () => call("machine.list"),
      (read, changes) => {
        this.#snapshot = { ...this.#snapshot, machines: read };
        this.docs.sync(this.#wanted(), false);
        this.pins.sync(this.#wanted(), false);
        this.#emit();
        for (const change of changes) for (const listener of this.#changes) listener(change);
      },
      options.now,
    );
    this.docs = new LayoutDocs(
      docCalls({ call }, () => this.machines.read.views),
      (changes) => {
        this.#snapshot = { ...this.#snapshot, docsLanded: this.#snapshot.docsLanded + 1 };
        this.#emit();
        for (const change of changes) for (const listener of this.#changes) listener(change);
      },
    );
    this.pins = new LayoutDocs(
      docCalls({ call }, () => this.machines.read.views, PINS_DOC),
      () => {
        this.#snapshot = { ...this.#snapshot, docsLanded: this.#snapshot.docsLanded + 1 };
        this.#emit();
      },
      readPinsDocument,
    );
    this.order = new LayoutDoc(
      {
        get: () => call("doc.get", { name: ORDER_DOC }),
        set: (_on, value, version) => call("doc.set", { name: ORDER_DOC, value, version }),
      },
      null,
      (state) => {
        this.#snapshot = { ...this.#snapshot, order: state };
        this.#emit();
      },
      readOrderDocument,
    );
    this.#snapshot = { terminals: NO_TERMINALS, machines: this.machines.read, order: this.order.state, docsLanded: 0 };
  }

  get snapshot(): RosterSnapshot {
    return this.#snapshot;
  }

  /** Runs this roster on a newer connection to the same core; what the screen shows stays until the fresh reads land. */
  attach(connection: RosterLink): void {
    if (connection === this.#connection) return;
    this.#connection = connection;
    if (this.#listeners.size === 0) return;
    this.#feed?.close();
    this.#feed = this.#openFeed();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) this.#start();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) this.#stop();
    };
  };

  onChange(listener: (change: RosterChange) => void): () => void {
    this.#changes.add(listener);
    return () => this.#changes.delete(listener);
  }

  onDoc(listener: DocHeard): () => void {
    this.#docHeard.add(listener);
    return () => this.#docHeard.delete(listener);
  }

  onGap(listener: () => void): () => void {
    this.#gaps.add(listener);
    return () => this.#gaps.delete(listener);
  }

  refreshMachines(): Promise<void> {
    return this.machines.refresh();
  }

  /** Asks the core for the terminal list and the stream again after a first answer that failed (#819). */
  retryTerminals(): void {
    this.#feed?.start();
  }

  #start(): void {
    this.#feed = this.#openFeed();
    const every = this.#options.every ?? browser.every;
    const visible = this.#options.visible ?? browser.visible;
    const whenVisible = this.#options.whenVisible ?? browser.whenVisible;
    const refresh = (): void => void this.machines.refresh();
    this.#stops = [every(() => (visible() ? refresh() : undefined), MACHINE_REFRESH_MS), whenVisible(refresh)];
  }

  #stop(): void {
    this.#feed?.close();
    this.#feed = undefined;
    for (const stop of this.#stops) stop();
    this.#stops = [];
    this.#key = undefined;
  }

  #openFeed(): RosterFeed | undefined {
    if (this.#connection.closed) return undefined;
    const feed = new RosterFeed(
      this.#connection,
      {
        terminals: (state) => this.#terminals(state),
        event: (event) => this.#event(event),
        gap: () => this.#gap(),
      },
      this.#options.schedule,
    );
    feed.start();
    return feed;
  }

  #terminals(state: TerminalsState): void {
    this.#snapshot = { ...this.#snapshot, terminals: state };
    this.#emit();
    if (!state.loaded) return;
    const key = machineKey(state.terminals);
    const changed = this.#key !== undefined && this.#key !== key;
    this.#key = key;
    if (changed) void this.machines.refresh();
  }

  #event(event: HcEvent): void {
    if (event.type !== "doc") return;
    const machine = event.machine ?? null;
    const { name, version } = event.data;
    for (const listener of this.#docHeard) listener(machine, name, version);
    if (name === ORDER_DOC && machine === null) void this.order.heard(version);
    if (name !== LAYOUT_DOC && name !== PINS_DOC) return;
    const id = machine === null ? null : this.machines.read.views.find((view) => view.name === machine)?.id;
    if (id === undefined) void this.machines.refresh();
    else (name === PINS_DOC ? this.pins : this.docs).heard(id, version);
  }

  #gap(): void {
    this.docs.sync(this.#wanted(), true);
    this.pins.sync(this.#wanted(), true);
    void this.order.refresh();
    void this.machines.refresh();
    for (const listener of this.#gaps) listener();
  }

  #wanted(): ReadonlySet<string | null> {
    const connected = this.machines.read.views.filter((view) => view.state === "connected").map((view) => view.id);
    return new Set<string | null>([null, ...connected]);
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

const rosters = new Map<string, Roster>();

/** The roster of the core a connection reaches, shared by every surface; a reconnect attaches to the same one. */
export function rosterFor(connection: HcConnection, options?: RosterOptions): Roster {
  const id = connection.hello.core.id;
  const known = rosters.get(id);
  if (known !== undefined) {
    known.attach(connection);
    return known;
  }
  const roster = new Roster(connection, options);
  rosters.set(id, roster);
  return roster;
}
