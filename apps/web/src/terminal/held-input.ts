import type { HcConnection } from "@doriface/client";
import type { UnprovenLinks } from "../connection/wake.ts";
import type { TerminalInput } from "./terminal-view.tsx";

/** Where input goes: the open stream, which answers false once it is no longer open. */
export interface InputSink {
  write(data: TerminalInput): boolean;
}

/**
 * One terminal's typed input, written in the order typed (#1370).
 *
 * Every input joins `pending` and leaves it only when a write took it, so none is written twice. It is written at once
 * unless the view's link is being proved after a wake: then it waits until the link answers, and goes to the same stream;
 * a link that does not answer is dropped, and what waited goes to the next stream with the reattach.
 */
export class HeldInput {
  /** Typed and not written yet, oldest first: no stream was open, or the link was being proved. */
  readonly pending: TerminalInput[] = [];
  readonly #links: UnprovenLinks;
  readonly #connection: () => HcConnection;
  readonly #sink: () => InputSink | null;

  constructor(links: UnprovenLinks, connection: () => HcConnection, sink: () => InputSink | null) {
    this.#links = links;
    this.#connection = connection;
    this.#sink = sink;
  }

  send(data: TerminalInput): void {
    this.pending.push(data);
    if (!this.#links.has(this.#connection())) this.flush();
  }

  /** Writes what waits until the stream refuses one; the refused input stays first in line for the next stream. */
  flush(): void {
    const sink = this.#sink();
    if (sink === null) return;
    for (let next = this.pending[0]; next !== undefined && sink.write(next); next = this.pending[0])
      this.pending.shift();
  }

  /** Writes what waited once this view's link is proved; returns the unsubscribe for the view's cleanup. */
  watch(): () => void {
    return this.#links.subscribe((connection, proven) => {
      if (proven && connection === this.#connection()) this.flush();
    });
  }
}
