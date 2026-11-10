/** What the core sends on a stream before it waits for credit back: over the relay, at most this a round trip (D5). */
export const CREDIT_WINDOW_BYTES = 256 * 1024;
/**
 * An attach replay's paint is held past each span this long only if the span wrote at least one credit window: a replay
 * still coming does, at a window a round trip, while output that trickles (a prompt, a spinner) never goes quiet (D5).
 */
export const REPLAY_CAP_MS = 1500;
/** An attach replay's paint is held for at most this much written output (D5). */
export const REPLAY_MAX_BYTES = 2 * 1024 * 1024;
/** The shortest quiet after the last replay bytes that ends a replay (D5). */
export const REPLAY_QUIET_FLOOR_MS = 100;

/** Milliseconds from some fixed point, for how long an update has been open. */
export type Clock = () => number;

/** Runs a callback once `ms` from now; returns how to cancel it. */
export type Timer = (run: () => void, ms: number) => () => void;

/** What an attach replay needs from its view: the link's round trip, and how to hold the terminal's paint. */
export interface ReplayOptions {
  /** The connection's smoothed round trip in ms, or undefined before it has one. */
  readonly srtt: () => number | undefined;
  /** Holds the terminal's paint (true) and lets it go (false); each is called once per replay. */
  readonly hold: (held: boolean) => void;
}

const idle = (): void => undefined;

/**
 * When an attach replay held by an OutputPacer ends: no output for max({@link REPLAY_QUIET_FLOOR_MS}, 1.5 x SRTT + 50)
 * ms, a {@link REPLAY_CAP_MS} span that wrote less than {@link CREDIT_WINDOW_BYTES}, or {@link REPLAY_MAX_BYTES}
 * written; `end` is called then. Its timers run only while the terminal is in view (see `OutputPacer.replay`).
 */
export class ReplayHold {
  readonly options: ReplayOptions;
  written = 0;
  /** What had been written when the current span began. */
  #spanFrom = 0;
  /** When its last bytes arrived, by the clock. */
  #lastAt: number;
  #quiet: () => void = idle;
  #cap: () => void = idle;
  readonly #clock: Clock;
  readonly #timer: Timer;
  readonly #end: () => void;

  constructor(options: ReplayOptions, clock: Clock, timer: Timer, end: () => void) {
    this.options = options;
    this.#clock = clock;
    this.#timer = timer;
    this.#end = end;
    this.#lastAt = clock();
  }

  /** Bytes of the replay arrived; in view, the quiet window starts again. */
  arrived(inView: boolean): void {
    this.#lastAt = this.#clock();
    if (inView) this.#quietFrom();
  }

  /** Bytes of the replay were written; true once {@link REPLAY_MAX_BYTES} have been. */
  wrote(bytes: number): boolean {
    this.written += bytes;
    return this.written >= REPLAY_MAX_BYTES;
  }

  /** In view from its start, or shown stopped at the credit window: the span and the quiet window run. */
  time(): void {
    this.#span();
    this.#quietFrom();
  }

  /**
   * Shown after it began out of view: stopped at the credit window (`stalled`), it is timed as from its start; bytes
   * still arriving are held until they go quiet, at most one quiet window, so live output is not held for a span; a
   * replay that went quiet out of view ends now, to be drawn in the first frame.
   */
  show(stalled: boolean): void {
    if (stalled) {
      this.time();
      return;
    }
    const quiet = this.#quietMs();
    if (this.#clock() - this.#lastAt >= quiet) {
      this.#end();
      return;
    }
    this.#quietFrom();
    this.#cap = this.#timer(this.#end, quiet);
  }

  /** Out of view again, or ended: its timers stop. */
  stop(): void {
    this.#quiet();
    this.#cap();
    this.#quiet = idle;
    this.#cap = idle;
  }

  #quietMs(): number {
    return Math.max(REPLAY_QUIET_FLOOR_MS, 1.5 * (this.options.srtt() ?? 0) + 50);
  }

  #quietFrom(): void {
    this.#quiet();
    this.#quiet = this.#onTime(this.#quietMs(), this.#end, () => this.#quietFrom());
  }

  /** Starts a {@link REPLAY_CAP_MS} span; at its end the replay ends unless the span wrote a credit window. */
  #span(): void {
    this.#spanFrom = this.written;
    this.#cap = this.#onTime(
      REPLAY_CAP_MS,
      () => (this.written - this.#spanFrom < CREDIT_WINDOW_BYTES ? this.#end() : this.#span()),
      () => this.#span(),
    );
  }

  /**
   * Runs `then` `ms` from now, or `again` when the timer runs more than `ms` late: a page that ran nothing for that long
   * (a starved tab, a phone waking) saw no output in it, which says nothing about whether the replay stopped coming.
   */
  #onTime(ms: number, then: () => void, again: () => void): () => void {
    const due = this.#clock() + ms;
    return this.#timer(() => (this.#clock() - due > ms ? again() : then()), ms);
  }
}
