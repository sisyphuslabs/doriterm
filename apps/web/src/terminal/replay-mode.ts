/** Milliseconds from some fixed point, as the pacer's clock. */
export type ReplayClock = () => number;

/** Runs a callback after `ms`; returns how to cancel it. */
export type ReplayTimer = (run: () => void, ms: number) => () => void;

/** The shortest quiet window: before a round-trip sample, and on a link faster than the floor. */
export const REPLAY_QUIET_FLOOR_MS = 100;
/** How much of the measured round trip the window covers: the credit slices arrive one round trip apart. */
const QUIET_SRTT_FACTOR = 1.5;
/** The window's slack over that round trip. */
const QUIET_SRTT_SLACK_MS = 50;
/** A replay ends this long after it began, however much output keeps arriving. */
export const REPLAY_CAP_MS = 1500;
/**
 * A replay ends after this many bytes. Above the core's own 4 MiB pending bound and far above a first paint (the screen
 * plus 2,000 history lines, several hundred KiB), it exists only to bound a boundary guess that went wrong.
 */
export const MAX_REPLAY_BYTES = 4 * 1024 * 1024;

export const afterTimeout: ReplayTimer = (run, ms) => {
  const id = setTimeout(run, ms);
  return () => clearTimeout(id);
};

/**
 * How long a replay waits for its next DATA frame before it is done (design D5): max(100 ms, 1.5 * SRTT + 50 ms). The
 * core's first paint arrives in credit-window slices one round trip apart, so a window shorter than the round trip would
 * end in the first credit gap; before there is a sample, the floor is all there is.
 */
export function replayQuietMs(srtt: number | undefined): number {
  if (srtt === undefined || !Number.isFinite(srtt)) return REPLAY_QUIET_FLOOR_MS;
  return Math.max(REPLAY_QUIET_FLOOR_MS, QUIET_SRTT_FACTOR * srtt + QUIET_SRTT_SLACK_MS);
}

/** Why a replay ended: its quiet window, the cap, the byte cap, or a synchronized update that paints it itself. */
export type ReplayEndReason = "quiet" | "cap" | "bytes" | "synchronized";

export interface ReplayOptions {
  readonly clock: ReplayClock;
  readonly timer?: ReplayTimer;
  /** The connection's smoothed round trip in ms, or undefined before its first sample. */
  readonly srtt: number | undefined;
  /** Called once, when the mode ends by itself; never after {@link ReplayMode.cancel}. */
  readonly onEnd: (reason: ReplayEndReason) => void;
}

/**
 * An attach's replay of the core's first paint (#812, design D5). The pacer writes its bytes as they arrive and holds the
 * view's paint, so the person keeps the old screen until the replay is whole. Its end is a bound, not a marker:
 * - quiet for {@link replayQuietMs} since the last DATA frame (the slices are one round trip apart);
 * - {@link REPLAY_CAP_MS} after it began;
 * - {@link MAX_REPLAY_BYTES} written;
 * - a synchronized update opened in the output (DECSET 2026), which already holds its own paint: the replay stands down
 *   rather than hold twice, and the update's path paints the replay instead.
 */
export class ReplayMode {
  readonly #clock: ReplayClock;
  readonly #timer: ReplayTimer;
  readonly #quietMs: number;
  readonly #onEnd: (reason: ReplayEndReason) => void;
  readonly #startedAt: number;
  #lastFrameAt: number;
  #bytes = 0;
  #ended = false;
  #cancelQuiet: (() => void) | null = null;
  #cancelCap: (() => void) | null = null;

  constructor(options: ReplayOptions) {
    this.#clock = options.clock;
    this.#timer = options.timer ?? afterTimeout;
    this.#quietMs = replayQuietMs(options.srtt);
    this.#onEnd = options.onEnd;
    this.#startedAt = this.#clock();
    // Before the first frame the quiet window runs from the start: an attach with no output does not hold the view.
    this.#lastFrameAt = this.#startedAt;
    this.#cancelCap = this.#timer(() => this.#capDue(), REPLAY_CAP_MS);
    this.#scheduleQuiet();
  }

  get ended(): boolean {
    return this.#ended;
  }

  /** A DATA frame of `bytes` was written: the quiet window starts now, and the byte cap may end the mode. */
  frame(bytes: number): void {
    if (this.#ended) return;
    this.#lastFrameAt = this.#clock();
    this.#bytes += bytes;
    if (this.#bytes >= MAX_REPLAY_BYTES) {
      this.#end("bytes");
      return;
    }
    this.#scheduleQuiet();
  }

  /** The output opened a synchronized update: it holds the paint itself, so this mode stands down. */
  standDown(): void {
    this.#end("synchronized");
  }

  /** The stream this replay belonged to is gone: forget it, with no end to report. */
  cancel(): void {
    this.#ended = true;
    this.#clear();
  }

  #scheduleQuiet(): void {
    this.#cancelQuiet?.();
    this.#cancelQuiet = this.#timer(() => this.#quietDue(), this.#quietMs);
  }

  #quietDue(): void {
    if (this.#ended) return;
    const remaining = this.#lastFrameAt + this.#quietMs - this.#clock();
    // A timer that ran early (a test's clock, or a platform rounding down) waits out the rest.
    if (remaining > 0) {
      this.#cancelQuiet = this.#timer(() => this.#quietDue(), remaining);
      return;
    }
    this.#end("quiet");
  }

  #capDue(): void {
    if (this.#ended) return;
    const remaining = this.#startedAt + REPLAY_CAP_MS - this.#clock();
    if (remaining > 0) {
      this.#cancelCap = this.#timer(() => this.#capDue(), remaining);
      return;
    }
    this.#end("cap");
  }

  #end(reason: ReplayEndReason): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#clear();
    this.#onEnd(reason);
  }

  #clear(): void {
    this.#cancelQuiet?.();
    this.#cancelCap?.();
    this.#cancelQuiet = null;
    this.#cancelCap = null;
  }
}
