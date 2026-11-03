/** Local monotonic time and timers (section 8.5: no wall clocks), injectable so tests drive time themselves. */
export interface Clock {
  now(): number;
  after(ms: number, run: () => void): () => void;
}

export const monotonicClock: Clock = {
  now: () => performance.now(),
  after(ms, run) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

export type Random = () => number;

export const uniform = (random: Random, min: number, max: number): number => min + random() * (max - min);
