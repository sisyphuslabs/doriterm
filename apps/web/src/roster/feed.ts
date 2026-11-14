import type { HcEvent } from "@doriface/protocol";
import { applyEvent, fromSnapshot, type TerminalMap } from "../workspace/terminals.ts";
import type { FeedLink, RosterLink } from "./link.ts";
import { machineCount, type TerminalsState } from "./terminals-state.ts";

export interface FeedSink {
  readonly terminals: (state: TerminalsState) => void;
  readonly event: (event: HcEvent) => void;
  /**
   * The feed can no longer vouch for what happened since its last event: a `missed` snapshot (hc dropped events for a
   * subscriber that fell behind, or a machine's line came or went), or a feed opened anew on a connection that stayed.
   * hc's contract (schema/README.md, Documents): read every document again after it.
   */
  readonly gap: () => void;
}

export type Schedule = (run: () => void, inMs: number) => () => void;

/** Real timers: what a Schedule is outside tests. */
export const timers: Schedule = (run, inMs) => {
  const timer = setTimeout(run, inMs);
  return () => clearTimeout(timer);
};

/** A feed that ended while its connection stays is opened again after this long, doubling to the cap. */
export const REOPEN_MS = 500;
const REOPEN_CAP_MS = 8_000;

/**
 * One `events.subscribe` on a connection, kept open as long as the connection is: a first picture from `terminal.list`,
 * the snapshot, then every event folded into the terminal map. A feed hc closes on its own (`closed_by_core`, a protocol
 * error) while the connection stays is opened again, since nothing else would, and each opening is a `gap`.
 */
export class RosterFeed {
  readonly #connection: RosterLink;
  readonly #sink: FeedSink;
  readonly #schedule: Schedule;
  #map: TerminalMap = new Map();
  #machines = 0;
  #loaded = false;
  #feed: Promise<FeedLink> | undefined;
  #closed = false;
  #reopens = 0;
  #pendingReopen: (() => void) | undefined;

  constructor(connection: RosterLink, sink: FeedSink, schedule: Schedule = timers) {
    this.#connection = connection;
    this.#sink = sink;
    this.#schedule = schedule;
  }

  /** Asks the core for the first picture and the stream; a first answer that failed is asked again by `start`. */
  start(): void {
    if (this.#closed || this.#connection.closed) return;
    this.#pendingReopen?.();
    this.#pendingReopen = undefined;
    this.#connection.call("terminal.list", { all: true }).then((list) => {
      if (this.#closed) return list;
      this.#machines = machineCount(list);
      if (this.#map.size === 0) this.#map = new Map(list.terminals.map((terminal) => [terminal.address, terminal]));
      this.#publish();
      return list;
    }, this.#fail);
    const feed = this.#connection.subscribe();
    this.#feed = feed;
    feed.then(
      (subscribed) => {
        if (this.#closed || this.#feed !== feed) {
          subscribed.close();
          return subscribed;
        }
        this.#reopens = 0;
        this.#map = fromSnapshot(subscribed.snapshot);
        this.#publish();
        this.#sink.gap();
        subscribed.onSnapshot((snapshot) => {
          this.#map = fromSnapshot(snapshot);
          this.#publish();
          this.#sink.gap();
        });
        subscribed.onEvent((event) => {
          this.#sink.event(event);
          const next = applyEvent(this.#map, event);
          if (next === this.#map) return;
          this.#map = next;
          this.#publish();
        });
        subscribed.onClose((info) => {
          if (this.#closed || this.#feed !== feed || info.reason === "detached") return;
          this.#feed = undefined;
          this.#reopen();
        });
        return subscribed;
      },
      (cause: unknown) => {
        this.#fail(cause);
        // A reopen that fails is tried again, backing off as a close does; only the first open waits for Try again (#819).
        if (this.#closed || this.#feed !== feed || !this.#loaded) return;
        this.#feed = undefined;
        this.#reopen();
      },
    );
  }

  #reopen(): void {
    if (this.#connection.closed) return;
    const inMs = Math.min(REOPEN_MS * 2 ** this.#reopens, REOPEN_CAP_MS);
    this.#reopens += 1;
    this.#pendingReopen = this.#schedule(() => this.start(), inMs);
  }

  close(): void {
    this.#closed = true;
    this.#pendingReopen?.();
    this.#pendingReopen = undefined;
    void this.#feed?.then(
      (subscribed) => subscribed.close(),
      () => undefined,
    );
  }

  /** A failed first answer is said with Try again (#819); one after the picture is in leaves the picture as it stands. */
  readonly #fail = (cause: unknown): void => {
    if (this.#closed) return;
    this.#sink.terminals({
      terminals: [...this.#map.values()],
      loaded: this.#loaded,
      machines: this.#machines,
      error: String(cause),
    });
  };

  #publish(): void {
    this.#loaded = true;
    this.#sink.terminals({ terminals: [...this.#map.values()], loaded: true, machines: this.#machines, error: null });
  }
}
