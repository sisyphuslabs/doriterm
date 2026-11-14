export const BACKOFF_MIN_MS = 250;
export const BACKOFF_MAX_MS = 30_000;

/** Jittered exponential delay before reconnect attempt `attempt` (0-based): uniform in [250 ms, min(30 s, 250 ms * 2^(attempt+1))]. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (attempt + 1));
  return Math.round(BACKOFF_MIN_MS + random() * (ceiling - BACKOFF_MIN_MS));
}

/**
 * The delay before redialing a closed uplink. One that had been stable redials in 0-249 ms, below the backoff floor, jittered so
 * hosts dropped together do not redial in the same tick (#2498); a rate-limited close, or an uplink that was not
 * stable, waits `backoffDelay(step)`.
 */
export function redialDelay(
  stable: boolean,
  rateLimited: boolean,
  step: number,
  random: () => number = Math.random,
): number {
  // 0-249 ms: below the 250 ms the first backoff step starts at, so a quick redial is never read as one.
  if (stable && !rateLimited) return Math.min(BACKOFF_MIN_MS - 1, Math.floor(random() * BACKOFF_MIN_MS));
  return backoffDelay(step, random);
}
