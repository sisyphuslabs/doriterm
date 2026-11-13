export const BACKOFF_MIN_MS = 250;
export const BACKOFF_MAX_MS = 30_000;

/** Jittered exponential delay before reconnect attempt `attempt` (0-based): uniform in [250 ms, min(30 s, 250 ms * 2^(attempt+1))]. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (attempt + 1));
  return Math.round(BACKOFF_MIN_MS + random() * (ceiling - BACKOFF_MIN_MS));
}

/**
 * The delay before redialing a closed uplink. One that had been stable was ended by a relay-side restart (#2498), so it
 * redials at once; any other waits `backoffDelay(attempt)`.
 */
export function redialDelay(stable: boolean, attempt: number, random: () => number = Math.random): number {
  return stable ? 0 : backoffDelay(attempt, random);
}
