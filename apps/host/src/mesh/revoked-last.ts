import type { Clock } from "./clock.ts";

interface Held {
  readonly cancel: () => void;
}

/**
 * Section 5.3: a revoked member is pushed to last. Its push is held until one ack has come back or the wait ran out,
 * then `release` delivers it.
 */
export class RevokedLast {
  readonly #clock: Clock;
  readonly #waitMs: number;
  readonly #release: (key: string) => void;
  readonly #held = new Map<string, Held>();

  constructor(options: { clock: Clock; waitMs: number; release: (key: string) => void }) {
    this.#clock = options.clock;
    this.#waitMs = options.waitMs;
    this.#release = options.release;
  }

  holds(key: string): boolean {
    return this.#held.has(key);
  }

  hold(key: string): void {
    if (this.#held.has(key)) return;
    this.#held.set(key, { cancel: this.#clock.after(this.#waitMs, () => this.#releaseOne(key)) });
  }

  releaseAll(): void {
    for (const key of this.#held.keys()) this.#releaseOne(key);
  }

  /** The host is stopping: drop the held pushes without dialing. */
  stop(): void {
    for (const held of this.#held.values()) held.cancel();
    this.#held.clear();
  }

  #releaseOne(key: string): void {
    const held = this.#held.get(key);
    if (held === undefined) return;
    held.cancel();
    this.#held.delete(key);
    this.#release(key);
  }
}
