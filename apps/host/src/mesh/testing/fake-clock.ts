import type { Clock, Random } from "../clock.ts";

interface Timer {
  readonly at: number;
  readonly seq: number;
  readonly run: () => void;
}

/** Lets every promise chain a step started run to its end, without letting any time pass. */
export async function settle(turns = 25): Promise<void> {
  if (turns === 0) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  return settle(turns - 1);
}

/** Virtual time: timers fire only inside `advance`, in due order, each followed by `settle()`. */
export class FakeClock implements Clock {
  #now = 0;
  #seq = 0;
  #timers: Timer[] = [];

  now(): number {
    return this.#now;
  }

  after(ms: number, run: () => void): () => void {
    const timer = { at: this.#now + Math.max(0, ms), seq: this.#seq++, run };
    this.#timers.push(timer);
    return () => {
      this.#timers = this.#timers.filter((entry) => entry !== timer);
    };
  }

  async advance(ms: number): Promise<void> {
    await settle();
    return this.#fireUntil(this.#now + ms);
  }

  async #fireUntil(end: number): Promise<void> {
    const due = this.#timers.filter((timer) => timer.at <= end).toSorted((a, b) => a.at - b.at || a.seq - b.seq);
    const next = due[0];
    if (next === undefined) {
      this.#now = end;
      return settle();
    }
    this.#timers = this.#timers.filter((timer) => timer !== next);
    this.#now = next.at;
    next.run();
    await settle();
    return this.#fireUntil(end);
  }

  /** Advances in steps until `done()` holds, and returns the virtual time it took; throws past `limitMs`. */
  async until(done: () => boolean, limitMs: number, stepMs = 250, start = this.#now): Promise<number> {
    await settle();
    if (done()) return this.#now - start;
    if (this.#now - start >= limitMs) throw new Error(`not reached within ${limitMs} ms of virtual time`);
    await this.advance(stepMs);
    return this.until(done, limitMs, stepMs, start);
  }
}

/** mulberry32: a small seeded generator, so jitter is reproducible. */
export function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
