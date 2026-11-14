import type { Schedule } from "./feed.ts";

/** A document whose read failed is read again after this long, doubling to the cap, until a read lands (#2443). */
export const REREAD_MS = 500;
const REREAD_CAP_MS = 8_000;

/**
 * Reads one document again after a read of it failed. A failed `doc.get` (a dropped link, a read past its deadline on a
 * loaded host) leaves the document unavailable, and nothing else asks for it again unless another device writes it or the
 * feed has a gap: a page whose first read after a reload failed would show no tabs for as long as it stays open (#2443).
 *
 * `read` runs only while `reading()` holds (the roster is in use, its connection open): a closed link's reads would only
 * fail again, and the reconnect's gap reads every document anyway.
 */
export class Reread {
  readonly #read: () => void;
  readonly #reading: () => boolean;
  readonly #schedule: Schedule;
  #attempts = 0;
  #cancel: (() => void) | undefined;

  constructor(read: () => void, reading: () => boolean, schedule: Schedule) {
    this.#read = read;
    this.#reading = reading;
    this.#schedule = schedule;
  }

  /** A read failed: read again after the next delay, replacing any read still waiting. */
  failed(): void {
    this.#cancel?.();
    const inMs = Math.min(REREAD_MS * 2 ** this.#attempts, REREAD_CAP_MS);
    this.#attempts += 1;
    this.#cancel = this.#schedule(() => {
      this.#cancel = undefined;
      if (this.#reading()) this.#read();
    }, inMs);
  }

  /** A read landed: nothing is owed, and the next failure starts from the first delay again. */
  landed(): void {
    this.stop();
    this.#attempts = 0;
  }

  /** The document is no longer wanted: a read still waiting does not run. */
  stop(): void {
    this.#cancel?.();
    this.#cancel = undefined;
  }
}
