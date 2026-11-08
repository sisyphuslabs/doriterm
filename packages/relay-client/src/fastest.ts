/** One of the sockets a best-of-N relay dial opens in parallel. */
export interface Entrant<T> {
  /** Resolves once the socket is open; rejects when it never opens. */
  readonly opened: Promise<T>;
  /** Times one round trip on the open socket, starting now; resolves `Infinity` when nothing answered. */
  roundTrip(value: T): Promise<number>;
  /** Closes a socket that lost, or that opened after the race was decided. */
  discard(value: T): void;
}

export interface RaceClock {
  now(): number;
  /** Runs `run` after `ms`; the returned function cancels it. */
  after(ms: number, run: () => void): () => void;
}

export interface RaceOptions {
  /** How long after the first answer a socket still opening or timing may take to beat it. */
  readonly graceMs: number;
  readonly clock?: RaceClock;
  /** The caller's cancellation: every socket is discarded and the race rejects with its reason. */
  readonly signal?: AbortSignal | undefined;
}

const realClock: RaceClock = {
  now: () => performance.now(),
  after: (ms, run) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

type Standing<T> =
  | { readonly kind: "opening" }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "timing"; readonly value: T; readonly since: number }
  | { readonly kind: "timed"; readonly value: T; readonly ms: number };

/** The entrant with the shortest answer so far, the earlier one on a tie. */
function leaderOf<T>(standings: readonly Standing<T>[]): number | undefined {
  let index: number | undefined;
  standings.forEach((standing, i) => {
    if (standing.kind !== "timed") return;
    const current = index === undefined ? undefined : standings[index];
    if (current?.kind !== "timed" || standing.ms < current.ms) index = i;
  });
  return index;
}

function cancelledBy(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("the relay session was cancelled");
}

/**
 * Keeps the entrant with the shortest round trip. The race is decided once some entrant has answered and no other can
 * still beat the best answer: one that is timing can only while it has waited less than that answer took, and none can
 * after `graceMs` past the first answer. Ties keep the earlier entrant; an unanswered entrant (`Infinity`) is kept only
 * when none answered. When every entrant fails to open, the race rejects with the first entrant's error.
 */
export function raceFastest<T>(entrants: readonly Entrant<T>[], options: RaceOptions): Promise<T> {
  const clock = options.clock ?? realClock;
  const { signal } = options;
  const standings: Standing<T>[] = entrants.map(() => ({ kind: "opening" }));
  let decided = false;
  let firstAnswerAt: number | undefined;
  let cancelTimer: (() => void) | undefined;
  return new Promise<T>((resolve, reject) => {
    function finish(winner: number | undefined, error?: unknown): void {
      decided = true;
      cancelTimer?.();
      signal?.removeEventListener("abort", onAbort);
      standings.forEach((standing, i) => {
        if (i !== winner && (standing.kind === "timing" || standing.kind === "timed"))
          entrants[i]?.discard(standing.value);
      });
      const kept = winner === undefined ? undefined : standings[winner];
      if (kept !== undefined && (kept.kind === "timed" || kept.kind === "timing")) resolve(kept.value);
      else reject(error);
    }
    function onAbort(): void {
      if (!decided && signal !== undefined) finish(undefined, cancelledBy(signal));
    }
    function decide(): void {
      if (decided) return;
      cancelTimer?.();
      const leader = leaderOf(standings);
      const leading = leader === undefined ? undefined : standings[leader];
      if (leading?.kind !== "timed" || firstAnswerAt === undefined) {
        const first = standings[0];
        if (first?.kind === "failed" && standings.every((standing) => standing.kind === "failed"))
          finish(undefined, first.error);
        return;
      }
      const graceEnds = firstAnswerAt + options.graceMs;
      let nextCheck = Number.POSITIVE_INFINITY;
      for (const standing of standings) {
        if (standing.kind === "opening") nextCheck = Math.min(nextCheck, graceEnds);
        if (standing.kind === "timing") nextCheck = Math.min(nextCheck, graceEnds, standing.since + leading.ms);
      }
      const now = clock.now();
      if (nextCheck <= now || nextCheck === Number.POSITIVE_INFINITY) return finish(leader);
      cancelTimer = clock.after(nextCheck - now, decide);
    }
    if (signal?.aborted === true) {
      reject(cancelledBy(signal));
      decided = true;
    } else signal?.addEventListener("abort", onAbort, { once: true });
    async function run(entrant: Entrant<T>, i: number): Promise<void> {
      let value: T;
      try {
        value = await entrant.opened;
      } catch (error) {
        if (decided) return;
        standings[i] = { kind: "failed", error };
        return decide();
      }
      if (decided) return entrant.discard(value);
      standings[i] = { kind: "timing", value, since: clock.now() };
      const ms = await entrant.roundTrip(value).catch(() => Number.POSITIVE_INFINITY);
      if (decided) return;
      standings[i] = { kind: "timed", value, ms };
      firstAnswerAt ??= clock.now();
      decide();
    }
    entrants.forEach((entrant, i) => void run(entrant, i));
  });
}
