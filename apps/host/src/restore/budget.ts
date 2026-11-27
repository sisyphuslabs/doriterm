const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MAX_ACTIVE_IDS = 4_096;

function take(times: number[], now: number, limit: number, duration: number): boolean {
  for (let first = times[0]; first !== undefined && first <= now - duration; first = times[0]) times.shift();
  if (times.length >= limit) return false;
  times.push(now);
  return true;
}

/** The relay independently limits the source address on its restore-only upgrade route. */
export class RestoreBudget {
  readonly #attempts = new Map<string, number[]>();
  readonly #global: number[] = [];

  handshake(now: number): boolean {
    return take(this.#global, now, 120, MINUTE);
  }

  lookup(id: string, now: number): boolean {
    let prior = this.#attempts.get(id);
    if (prior === undefined) {
      if (this.#attempts.size >= MAX_ACTIVE_IDS) {
        for (const [key, times] of this.#attempts) {
          if ((times.at(-1) ?? 0) <= now - DAY) this.#attempts.delete(key);
        }
        if (this.#attempts.size >= MAX_ACTIVE_IDS) return false;
      }
      this.#attempts.set(id, (prior = []));
    }
    if (prior.filter((at) => at > now - MINUTE).length >= 5) return false;
    return take(prior, now, 30, DAY);
  }
}
