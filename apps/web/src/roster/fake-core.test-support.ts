import type { FeedClose } from "@doriface/client";
import {
  type HcEvent,
  type HcMethod,
  type HcResult,
  type HcSnapshot,
  HcRpcError,
  isJsonObject,
  type JsonValue,
  type MachineView,
  type Terminal,
} from "@doriface/protocol";
import type { FeedLink, RosterLink } from "./link.ts";

export const terminal = (address: string, fields: Partial<Terminal> = {}): Terminal => ({
  address,
  argv: ["sh"],
  cols: 80,
  rows: 24,
  created_ms: 0,
  cwd: "/work",
  labels: {},
  screen: "",
  state: "live",
  ...fields,
});

export const machine = (name: string, state = "connected"): MachineView => ({
  name,
  state,
  host: name,
  id: `${name}-id`,
  target: `ssh ${name}`,
  version: "0.1.17",
});

export const space = (id: string, name = id): JsonValue => ({ id, name, folder: "", tabs: [] });

type Unsequenced<E = HcEvent> = E extends HcEvent ? Omit<E, "seq"> : never;

export interface FakeFeed extends FeedLink {
  /** An event as hc would send it, with the next sequence number. */
  readonly emit: (event: Unsequenced) => void;
  /** hc's `missed`: the subscriber fell behind, or a machine's line came or went; a fresh snapshot, no documents. */
  readonly missed: () => void;
  readonly end: (reason: FeedClose["reason"]) => void;
  readonly ended: () => boolean;
}

type Doc = { value: JsonValue; version: number };
const docKey = (name: string, on: string | null | undefined): string => `${on ?? ""}\u0000${name}`;
const refused = (kind: string, message = kind): HcRpcError => new HcRpcError({ code: -32000, message, data: { kind } });

/**
 * A core with machines, terminals and documents that answers the five calls the roster makes and hands out feeds a test
 * drives by hand, so an event, a `missed` or a dropped feed happens exactly when the test says. Writes made "on another
 * device" (`setDoc`) emit the `doc` event hc emits, unless the test holds it back to stand for a gap.
 */
export class FakeCore {
  readonly id: string;
  readonly calls: string[] = [];
  readonly feeds: FakeFeed[] = [];
  machines: readonly MachineView[] = [];
  terminals: readonly Terminal[] = [];
  /** How many of the next `events.subscribe` calls fail, as a reopen against a core that is restarting would. */
  failSubscribes = 0;
  /** How many of the next `doc.get` calls fail, as a read past its deadline on a loaded host does. */
  failDocGets = 0;
  /** Whether `machine.list` fails, as it does while hc cannot reach the machine table. */
  failMachineList = false;
  /** While set, `machine.list` answers only once it settles, as a stalled link would. */
  holdMachineList: Promise<void> | undefined;
  readonly #docs = new Map<string, Doc>();
  #seq = 0;

  constructor(id = "core-1") {
    this.id = id;
  }

  doc(name: string, on: string | null = null): Doc {
    return this.#docs.get(docKey(name, on)) ?? { value: null, version: 0 };
  }

  /** Another device writes a document: the version moves and every open feed hears `doc`, unless `quietly`. */
  setDoc(name: string, value: JsonValue, on: string | null = null, quietly = false): void {
    const version = this.doc(name, on).version + 1;
    this.#docs.set(docKey(name, on), { value, version });
    if (quietly) return;
    for (const feed of this.feeds) {
      if (!feed.ended()) feed.emit({ type: "doc", data: { name, version }, ...(on === null ? {} : { machine: on }) });
    }
  }

  /** A connection to this core; `closed` becomes true once `drop` is called on it. */
  connection(): RosterLink & { readonly drop: () => void } {
    let closed = false;
    const link = {
      hello: { core: { id: this.id, name: "fake" }, features: [], framed: true, generation: 1, methods: [] },
      get closed() {
        return closed;
      },
      call: (method: HcMethod, params?: unknown) => this.#call(method, params),
      subscribe: async (): Promise<FeedLink> => {
        if (this.failSubscribes > 0) {
          this.failSubscribes -= 1;
          throw refused("unavailable", "events.subscribe failed");
        }
        return this.#feed();
      },
      drop: () => {
        closed = true;
        for (const feed of this.feeds) if (!feed.ended()) feed.end("connection_closed");
      },
    };
    // The fake answers five methods by name, which the generic call signature cannot express (as use-layout-docs.test).
    return link as never;
  }

  async #call(method: HcMethod, params: unknown): Promise<unknown> {
    this.calls.push(method);
    const p = isJsonObject(params) ? params : {};
    const name = typeof p["name"] === "string" ? p["name"] : "";
    const on = typeof p["on"] === "string" ? p["on"] : null;
    switch (method) {
      case "terminal.list":
        return {
          terminals: this.terminals,
          hidden_finished: 0,
          machines: this.machines,
        } satisfies HcResult<"terminal.list">;
      case "machine.list":
        await this.holdMachineList;
        if (this.failMachineList) throw refused("unavailable", "machine.list failed");
        return { machines: this.machines } satisfies HcResult<"machine.list">;
      case "doc.get":
        this.#known(on);
        if (this.failDocGets > 0) {
          this.failDocGets -= 1;
          throw refused("timeout", "doc.get did not answer in time");
        }
        return this.doc(name, on);
      case "doc.set": {
        this.#known(on);
        const current = this.doc(name, on);
        if (current.version !== p["version"]) throw refused("conflict", `is at version ${current.version}`);
        this.setDoc(name, p["value"] ?? null, on);
        return { version: current.version + 1 } satisfies HcResult<"doc.set">;
      }
      default:
        throw refused("method_not_found", method);
    }
  }

  #known(on: string | null): void {
    if (on !== null && !this.machines.some((view) => view.name === on)) throw refused("machine_unknown");
  }

  #feed(): FakeFeed {
    const snapshot = (): HcSnapshot => ({ seq: this.#seq, terminals: this.terminals });
    const events = new Set<(event: HcEvent) => void>();
    const snapshots = new Set<(snapshot: HcSnapshot) => void>();
    const closes = new Set<(close: FeedClose) => void>();
    let ended = false;
    const feed: FakeFeed = {
      snapshot: snapshot(),
      onEvent: (listener) => (events.add(listener), () => events.delete(listener)),
      onSnapshot: (listener) => (snapshots.add(listener), () => snapshots.delete(listener)),
      onClose: (listener) => (closes.add(listener), () => closes.delete(listener)),
      close: () => feed.end("detached"),
      emit: (event) => {
        this.#seq += 1;
        for (const listener of events) listener({ ...event, seq: this.#seq });
      },
      missed: () => {
        for (const listener of snapshots) listener(snapshot());
      },
      end: (reason) => {
        if (ended) return;
        ended = true;
        for (const listener of closes) listener({ reason });
      },
      ended: () => ended,
    };
    this.feeds.push(feed);
    return feed;
  }
}
