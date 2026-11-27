/**
 * The least a synchronized update may go with no bytes before its paint is let go and the rest of it is paced (the
 * floor of its quiet window, max(this, 1.5 x SRTT + 50), #2306): wterm's own hold of one (@wterm/dom's
 * `SYNCHRONIZED_OUTPUT_TIMEOUT_MS`, which output-pacer.test.ts reads from the installed package), so an update a
 * program left open is drawn a second after its last bytes, as wterm would (#853).
 */
export const SYNCHRONIZED_UNPACED_MS = 1000;
/**
 * The longest a synchronized update still arriving holds the paint (#2040): a program that writes inside an update it
 * never closes is drawn after this. A whole transcript's redraw on a page starved 6x took up to 13.4 s to come in.
 */
export const SYNCHRONIZED_HOLD_CAP_MS = 20_000;

/** What a held update needs from the pacer that holds it. */
export interface HeldUpdateDeps {
  /** Runs `run` in `ms`; returns its cancel. */
  readonly timer: (run: () => void, ms: number) => () => void;
  /** The pacer's late-proof timer: `then` on time, `again` when the page was too busy to see output meanwhile. */
  readonly onTime: (ms: number, then: () => void, again: () => void) => () => void;
  /** The link's smoothed round trip, when known. */
  readonly srtt: () => number | undefined;
  /** Holds the terminal's paint (true) and lets it go (false). */
  readonly hold: (held: boolean) => void;
  /** The paint was let go: what is queued is paced from here. */
  readonly ended: () => void;
  /** How much the core's own paint may write while held (#2794). */
  readonly paintMaxBytes: number;
}

/**
 * The synchronized update whose paint is held while its bytes still arrive. A program's update is let go once it
 * closes, goes quiet, or hits {@link SYNCHRONIZED_HOLD_CAP_MS}. The core's own paint (`paint`: the update opens the
 * replay's first byte, herdr-core #232) marks its end, so it is held until it closes or has written
 * {@link HeldUpdateDeps.paintMaxBytes}, with no quiet window or cap: a starved link or page may take minutes to bring
 * it (#2794).
 */
export class HeldUpdate {
  readonly #deps: HeldUpdateDeps;
  #active = false;
  #paint = false;
  /** What the core's paint has written while held. */
  #written = 0;
  #quiet: () => void = () => undefined;
  #cap: () => void = () => undefined;

  constructor(deps: HeldUpdateDeps) {
    this.#deps = deps;
  }

  get active(): boolean {
    return this.#active;
  }

  /** Held, and the core's own paint. */
  get paint(): boolean {
    return this.#active && this.#paint;
  }

  start(paint: boolean): void {
    if (this.#active) return;
    this.#active = true;
    this.#paint = paint;
    this.#written = 0;
    this.#deps.hold(true);
    if (paint) return;
    this.#quietFrom();
    this.#cap = this.#deps.timer(() => this.end(), SYNCHRONIZED_HOLD_CAP_MS);
  }

  /** More of a program's update arrived or was written: its quiet window starts again. */
  drawing(): void {
    if (this.#active && !this.#paint) this.#quietFrom();
  }

  /** `size` bytes were written while held: they count toward the core's paint bound. */
  wrote(size: number): void {
    if (!this.paint) return;
    this.#written += size;
    if (this.#written >= this.#deps.paintMaxBytes) this.end();
  }

  /** Lets the update's paint go: it closed (drawn whole), went quiet, or hit the cap (what is left of it is paced). */
  end(): void {
    if (!this.#active) return;
    this.#active = false;
    this.#quiet();
    this.#cap();
    this.#quiet = () => undefined;
    this.#cap = () => undefined;
    this.#deps.hold(false);
    this.#deps.ended();
  }

  #quietFrom(): void {
    this.#quiet();
    this.#quiet = this.#deps.onTime(
      Math.max(SYNCHRONIZED_UNPACED_MS, 1.5 * (this.#deps.srtt() ?? 0) + 50),
      () => this.end(),
      () => this.#quietFrom(),
    );
  }
}
