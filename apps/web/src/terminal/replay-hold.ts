/** What the core sends on a stream before it waits for credit back: over the relay, at most this a round trip (D5). */
export const CREDIT_WINDOW_BYTES = 256 * 1024;
/**
 * An attach replay's paint is held past each span this long only if the span and the one before it wrote at least one
 * credit window between them: a replay still coming does, at a window a round trip or, on a page slow to take each
 * window in, about a window a span, cut anywhere by the span's ends (#2271). Output that trickles (a prompt, a spinner)
 * never goes quiet, and writes less than {@link REPLAY_TRICKLE_BYTES} a span (D5).
 */
export const REPLAY_CAP_MS = 1500;
/** A {@link REPLAY_CAP_MS} span that wrote less than this is a trickle, not a replay: it lets the replay go (D5, #2271). */
export const REPLAY_TRICKLE_BYTES = CREDIT_WINDOW_BYTES / 4;
/** An attach replay's paint is held for at most this much written output (D5). */
export const REPLAY_MAX_BYTES = 2 * 1024 * 1024;
/** The shortest quiet after the last replay bytes that ends a replay (D5). */
export const REPLAY_QUIET_FLOOR_MS = 100;

/** What an attach replay needs from its view: the link's round trip, and how to hold the terminal's paint. */
export interface ReplayOptions {
  /** The connection's smoothed round trip in ms, or undefined before it has one. */
  readonly srtt: () => number | undefined;
  /** Holds the terminal's paint (true) and lets it go (false); each is called once per replay. */
  readonly hold: (held: boolean) => void;
}

/** What a replay hold needs from the pacer that holds it. */
export interface ReplayHoldDeps {
  /** The pacer's late-proof timer: `then` on time, `again` when the page was too busy to see output meanwhile. */
  readonly onTime: (ms: number, then: () => void, again: () => void) => () => void;
  /** The paint was let go; `wrote`: any of the replay was written while it was held. */
  readonly ended: (wrote: boolean) => void;
}

/**
 * An attach replay's hold: its output is written as it arrives, uncapped, while the view holds the terminal's paint, so
 * the replay is drawn once, whole, and the screen before it stays until then. The hold ends at the first of: no output
 * arriving or written for max({@link REPLAY_QUIET_FLOOR_MS}, 1.5 x SRTT + 50) ms, a {@link REPLAY_CAP_MS} span that
 * wrote a trickle or, with the span before it, less than {@link CREDIT_WINDOW_BYTES}, or {@link REPLAY_MAX_BYTES}
 * written.
 *
 * hc marks no end of the replay: the core sends its first paint as one write, cut into frames under the stream's
 * credit window, and waits for credit after each window; credit goes back as each batch is written, and a replay is
 * written as it arrives. So a replay still coming arrives at least a window a round trip, however slow the link: from
 * the end of the write that handed a window's credit back, the next window is at most a round trip away, under the
 * quiet window, which restarts at each arrival and again after each write (on a page slow to write, the gap between
 * arrivals is a round trip plus the write, #2011), and whose SRTT is sampled on this connection (the attach answer
 * itself is one sample), and every two spans of {@link REPLAY_CAP_MS} (a round trip or more) write a window or more:
 * on a page slow to take each window in, a window can take about a span, and a span's ends can cut it anywhere, so
 * one span alone can catch part of one (#2271). Its timers are the pacer's late-proof ones (#2895). A fixed deadline
 * could not hold it: over a 300 ms relay, or on a page slow to write it, a replay of a few hundred KiB to 2 MiB takes
 * longer than any one span.
 */
export class ReplayHold {
  readonly #deps: ReplayHoldDeps;
  #options: ReplayOptions | null = null;
  #written = 0;
  /** What had been written when the current {@link REPLAY_CAP_MS} span began. */
  #spanStart = 0;
  /** What the span before the current one wrote, or null in the first span. */
  #lastSpan: number | null = null;
  #quiet: () => void = () => undefined;
  #cap: () => void = () => undefined;

  constructor(deps: ReplayHoldDeps) {
    this.#deps = deps;
  }

  get active(): boolean {
    return this.#options !== null;
  }

  /** What the replay has written so far; 0 when none is held. */
  get written(): number {
    return this.#written;
  }

  /** A replay begins, ending any before it; the view's paint is held. */
  begin(options: ReplayOptions): void {
    this.end();
    this.#options = options;
    this.#written = 0;
    this.#lastSpan = null;
    this.#spanFrom();
    options.hold(true);
    this.#quietFrom();
  }

  /** More of it arrived: its quiet window starts again. */
  arrived(): void {
    if (this.active) this.#quietFrom();
  }

  /**
   * `size` bytes of it were written. A synchronized update holds the paint for what it brackets itself, so a replay
   * that met one (`synchronized`) stands down instead of holding a second time: the update's bracket draws the replay
   * (#812). The core sends the next window only once this one's credit is back, which is now, after the write: the
   * quiet window starts here too, or a page slow to write a window would spend the window's slack on the write (#2011).
   */
  wrote(size: number, synchronized: boolean): void {
    if (!this.active) return;
    this.#written += size;
    if (synchronized || this.#written >= REPLAY_MAX_BYTES) this.end();
    else this.#quietFrom();
  }

  end(): void {
    const options = this.#options;
    if (options === null) return;
    this.#options = null;
    this.#quiet();
    this.#cap();
    this.#quiet = () => undefined;
    this.#cap = () => undefined;
    options.hold(false);
    this.#deps.ended(this.#written > 0);
    this.#written = 0;
  }

  #quietFrom(): void {
    this.#quiet();
    const quiet = Math.max(REPLAY_QUIET_FLOOR_MS, 1.5 * (this.#options?.srtt() ?? 0) + 50);
    this.#quiet = this.#deps.onTime(
      quiet,
      () => this.end(),
      () => this.#quietFrom(),
    );
  }

  /**
   * Starts a {@link REPLAY_CAP_MS} span; at its end the replay is let go if the span wrote a trickle, or if it and the span
   * before it wrote less than a credit window between them. The first span, with none before it, needs half a window.
   */
  #spanFrom(): void {
    this.#spanStart = this.#written;
    this.#cap = this.#deps.onTime(
      REPLAY_CAP_MS,
      () => {
        const span = this.#written - this.#spanStart;
        if (span < REPLAY_TRICKLE_BYTES || span + (this.#lastSpan ?? span) < CREDIT_WINDOW_BYTES) this.end();
        else {
          this.#lastSpan = span;
          this.#spanFrom();
        }
      },
      () => this.#spanFrom(),
    );
  }
}
