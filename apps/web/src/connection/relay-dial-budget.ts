/**
 * How many relay upgrades the page opens in any minute, across every dial it makes: fresh connects and session resumes,
 * for every machine it reaches (#2933 review). A web page's dials carry no pass proof, so the relay charges each socket to
 * the per-source limit: 60 upgrades a minute per source address (docs/transport.md, the relay section). A fresh connect
 * opens up to 3 sockets (best-of-3) and a resume 1, so a dial costs its sockets. The page keeps to 45, which leaves 15 for
 * another tab or device behind the same address.
 *
 * One machine never waits on it: its fresh-connect ladder (store.ts) dials about 12 times in its first minute, 36
 * upgrades, and a resume's ladder (session-resume.ts) about 24, 24 upgrades. Two or more machines down at once, as when
 * the network goes, share it.
 */
export const RELAY_UPGRADES_PER_MINUTE = 45;

const MINUTE_MS = 60_000;

interface Spent {
  readonly at: number;
  readonly cost: number;
}

/** A sliding minute of upgrades: a dial waits until its sockets fit in it, then counts them. */
export class DialBudget {
  readonly #perMinute: number;
  readonly #now: () => number;
  #spent: Spent[] = [];

  constructor(perMinute: number, now: () => number = Date.now) {
    this.#perMinute = perMinute;
    this.#now = now;
  }

  /** Milliseconds until `cost` more upgrades fit in the last minute: 0 when they fit now. */
  waitMs(cost: number): number {
    const now = this.#now();
    this.#spent = this.#spent.filter(({ at }) => now - at < MINUTE_MS);
    let used = this.#spent.reduce((sum, spent) => sum + spent.cost, 0);
    if (used + cost <= this.#perMinute) return 0;
    // The oldest upgrades leave the minute first: wait until enough of them have gone for this dial to fit.
    for (const spent of this.#spent) {
      used -= spent.cost;
      if (used + cost <= this.#perMinute) return MINUTE_MS - (now - spent.at);
    }
    return 0;
  }

  /** Waits until `cost` upgrades fit, then counts them; rejects with the signal's reason if the dial is cancelled first. */
  async acquire(cost: number, signal?: AbortSignal): Promise<void> {
    for (let wait = this.waitMs(cost); wait > 0; wait = this.waitMs(cost)) {
      // oxlint-disable-next-line no-await-in-loop -- the budget is asked again once the wait is over
      await sleep(wait, signal);
    }
    signal?.throwIfAborted();
    this.#spent.push({ at: this.#now(), cost });
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (signal?.aborted === true) {
    reject(signal.reason);
    return promise;
  }
  const timer = setTimeout(done, ms);
  function done(): void {
    signal?.removeEventListener("abort", aborted);
    resolve();
  }
  function aborted(): void {
    clearTimeout(timer);
    reject(signal?.reason);
  }
  signal?.addEventListener("abort", aborted, { once: true });
  return promise;
}

/** The page's one budget: every relay dial the page makes acquires from it (connect.ts). */
export const relayUpgrades = new DialBudget(RELAY_UPGRADES_PER_MINUTE);
