/**
 * How many resume dials the page makes in any minute, across all its connections (#2928 review). A web page's relay
 * dials carry no pass proof, so the relay charges each socket to the per-source limit: 60 upgrades a minute per source
 * address (docs/transport.md, the relay section). A resume dial opens one socket (connect.ts), so this budget is at most
 * 30 of those 60, which leaves the rest for fresh connects (3 sockets each) and for another tab or device behind the
 * same address. One connection's ladder dials at most about 24 times in its first minute (RESUME_BACKOFF_MS), so a single
 * resume never waits on this budget; several resumes at once, as when the network goes for every machine, share it.
 */
export const RESUME_DIALS_PER_MINUTE = 30;

const MINUTE_MS = 60_000;

/** A sliding minute of dials: how long until the next may go, and the record of one that went. */
export class DialBudget {
  readonly #perMinute: number;
  readonly #now: () => number;
  #at: number[] = [];

  constructor(perMinute: number, now: () => number = Date.now) {
    this.#perMinute = perMinute;
    this.#now = now;
  }

  /** Milliseconds until a dial may go: 0 while the last minute holds fewer than the budget. */
  waitMs(): number {
    const now = this.#now();
    this.#at = this.#at.filter((at) => now - at < MINUTE_MS);
    const oldest = this.#at[0];
    return this.#at.length < this.#perMinute || oldest === undefined ? 0 : MINUTE_MS - (now - oldest);
  }

  /** A dial went now. */
  take(): void {
    this.#at.push(this.#now());
  }
}

/** The page's one budget, which every connection's resume shares (resume-wiring.ts). */
export const resumeDials = new DialBudget(RESUME_DIALS_PER_MINUTE);
