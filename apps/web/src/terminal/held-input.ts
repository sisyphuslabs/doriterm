import type { HcConnection } from "@doriface/client";
import type { UnprovenLinks } from "../connection/wake.ts";
import type { MachineLines } from "./machine-lines.ts";
import type { TerminalInput } from "./terminal-view-props.ts";

/** Where input goes: the open stream, which answers false once it is no longer open. */
export interface InputSink {
  write(data: TerminalInput): boolean;
}

/** How long input waits for its stream, link or machine's line before it is dropped: never sent stale (#1489, #2003). */
export const HOLD_MS = 10_000;
/** The most input, in bytes, that waits; more is dropped rather than sent late (#1489, #2003). */
export const HOLD_BYTES = 4096;

/** Why input that waited was dropped. */
export type Dropped = "expired" | "overflow";

/** The added machine a terminal is on: while its line is down, input waits for it instead of being lost (#1489). */
export interface MachineHold {
  readonly lines: MachineLines;
  /** The terminal's added machine by name; undefined for a terminal on the machine the page is connected to. */
  readonly machine: () => string | undefined;
  /** Input that waited was dropped, none of it sent; `machine` is the added machine it waited for, if any. */
  readonly dropped: (why: Dropped, machine: string | undefined) => void;
}

const encoder = new TextEncoder();
const sizeOf = (data: TerminalInput): number => (typeof data === "string" ? encoder.encode(data).length : data.length);
const isInterrupt = (data: TerminalInput): boolean =>
  typeof data === "string" ? data === "\u0003" : data.length === 1 && data[0] === 0x03;

/**
 * One terminal's typed input, written in the order typed (#1370).
 *
 * Every input joins `pending` and leaves it only when a write took it, so none is written twice. It is written at once
 * unless the view's link is being proved after a wake: then it waits until the link answers, and goes to the same stream;
 * a link that does not answer is dropped, and what waited goes to the next stream with the reattach.
 *
 * Input for a terminal whose added machine's line is down waits too, since hc drops it while keeping the stream open
 * (#1489). Whatever it waits for (a stream after a drop, a link being proved, a machine's line) the wait is the same
 * (#2003): Ctrl+C goes ahead of the rest as it joins, so a runaway program stops before the rest arrives, and past
 * HOLD_BYTES, or HOLD_MS after the link is known to be down, what waits is dropped, and the view says it was not sent. A
 * link being proved is not known down: its check has its own deadline (WAKE_PROBE_MAX_MS), and HOLD_MS starts if it fails.
 */
export class HeldInput {
  /** Typed and not written yet, oldest first: no stream was open, the link was being proved, or the machine was away. */
  readonly pending: TerminalInput[] = [];
  /** True while a drain is inside sink.write, so a release that fires from there does not take a byte twice (#1490). */
  #flushing = false;
  readonly #links: UnprovenLinks;
  readonly #connection: () => HcConnection;
  readonly #sink: () => InputSink | null;
  readonly #hold: MachineHold | undefined;
  /** Bytes waiting, and the drop due once HOLD_MS has passed; none while nothing waits. */
  #heldBytes = 0;
  #expiry: ReturnType<typeof setTimeout> | undefined;

  constructor(links: UnprovenLinks, connection: () => HcConnection, sink: () => InputSink | null, hold?: MachineHold) {
    this.#links = links;
    this.#connection = connection;
    this.#sink = sink;
    this.#hold = hold;
  }

  /** Input sent now would be written at once: a stream is open and proven, the machine is here, nothing waits. */
  ready(): boolean {
    return (
      this.pending.length === 0 &&
      this.#sink() !== null &&
      !this.#links.has(this.#connection()) &&
      this.#awayMachine() === undefined
    );
  }

  send(data: TerminalInput): void {
    if (this.ready()) {
      this.pending.push(data);
      return this.flush();
    }
    this.#wait(this.#awayMachine(), data);
    if (!this.#links.has(this.#connection())) this.flush();
  }

  /** Writes what waits until the stream refuses one; the refused input stays first in line for the next stream. */
  flush(): void {
    const sink = this.#sink();
    if (sink === null || this.#awayMachine() !== undefined) return;
    // A release can fire from inside sink.write - the link proving, or a machine's line coming back - before the loop
    // has shifted the byte that write just took. Draining again from there would take the same byte twice (#1490).
    if (this.#flushing) return;
    this.#flushing = true;
    try {
      for (let next = this.pending[0]; next !== undefined && sink.write(next); next = this.pending[0])
        this.pending.shift();
    } finally {
      this.#flushing = false;
    }
    if (this.pending.length === 0) this.#release();
  }

  /** Writes what waited once this view's link is proved or its machine is back; returns the cleanup for the view. */
  watch(): () => void {
    const proved = this.#links.subscribe((connection, proven) => {
      if (connection !== this.#connection()) return;
      if (proven) this.flush();
      else if (this.pending.length > 0) this.#expireIn(undefined);
    });
    const lines = this.#hold?.lines.subscribe((connection) => {
      if (connection === this.#connection() && this.#awayMachine() === undefined) this.#back();
    });
    return () => {
      proved();
      lines?.();
      this.#release();
    };
  }

  /** The terminal's added machine while its line is down, as last read; undefined otherwise. */
  #awayMachine(): string | undefined {
    const machine = this.#hold?.machine();
    if (machine === undefined || this.#hold?.lines.down(this.#connection(), machine) !== true) return undefined;
    return machine;
  }

  /** Input that cannot be written now waits, interrupts ahead of the rest; a wait drained by a reattach starts afresh. */
  #wait(machine: string | undefined, data: TerminalInput): void {
    if (this.pending.length === 0) this.#release();
    this.#heldBytes += sizeOf(data);
    if (this.#heldBytes > HOLD_BYTES) return this.#drop("overflow", machine);
    const firstOther = this.pending.findIndex((waiting) => !isInterrupt(waiting));
    if (isInterrupt(data) && firstOther !== -1) this.pending.splice(firstOther, 0, data);
    else this.pending.push(data);
    if (machine !== undefined || this.#sink() === null) this.#expireIn(machine);
  }

  /** What waits is dropped HOLD_MS from now, unless a drop is already due. */
  #expireIn(machine: string | undefined): void {
    this.#expiry ??= setTimeout(() => this.#drop("expired", machine), HOLD_MS);
  }

  /** The machine's line is back: what waited for it goes out, as it waits (interrupts first). */
  #back(): void {
    if (this.#expiry === undefined) return;
    if (!this.#links.has(this.#connection())) this.flush();
  }

  #drop(why: Dropped, machine: string | undefined): void {
    this.#release();
    const lost = this.pending.splice(0).length;
    // A reattach may have taken what waited already; then nothing was lost here.
    if (lost > 0 || why === "overflow") this.#hold?.dropped(why, machine);
  }

  #release(): void {
    clearTimeout(this.#expiry);
    this.#expiry = undefined;
    this.#heldBytes = 0;
  }
}
