/** wterm's own hold of a synchronized update's paint (1000 ms), after which it paints the update anyway. */
export const SYNCHRONIZED_HOLD_MS = 1000;

/**
 * How far past wterm's hold a held cell may wait for that paint. wterm starts its 1000 ms inside the write that opens the
 * update (the same call that sets the bridge's synchronized flag), so a hold first seeing the update at its next frame
 * counts from after it. A hold made from inside that write, by a reply the write sends, sees the update open a fraction
 * of a millisecond before wterm starts its timer; were the cap due first, the cell would go a frame before the echo is
 * painted, a blank frame (#2083). wterm's fallback writes the grid in its own timer task, so with the cap behind it the
 * grid change releases the cell in the frame the echo appears.
 */
export const SYNCHRONIZED_HOLD_MARGIN_MS = 250;

/** What the release reads and schedules with; the hook passes the browser's, a test passes fakes. */
export interface ReleaseClock {
  now(): number;
  frame(run: () => void): () => void;
  timer(run: () => void, ms: number): () => void;
  /** The program has a synchronized update (DECSET 2026) open, so the renderer may not paint its writes yet. */
  synchronized(): boolean;
  /** Which synchronized update is open: a write that closes one and opens the next moves it on. */
  generation(): number;
}

/**
 * When the overlay lets go of a cell it holds over an echo the renderer has not painted yet (design review HIGH 4,
 * #1439). A grid change means the renderer painted: release at once. Otherwise the renderer paints a write on the next
 * frame, so release then, unless the program has a synchronized update open: wterm then paints nothing until the update
 * ends (or its own 1000 ms fallback fires), which changes the grid; releasing on the next frame instead would blank the
 * cell for as long as the update lasts. That wait is capped at SYNCHRONIZED_HOLD_MS plus SYNCHRONIZED_HOLD_MARGIN_MS from
 * when the update was first seen open. A write that closes the update and opens the next restarts wterm's hold without
 * painting, so when the cap falls on a newer update than the one it was armed for, it counts again from then (#2089).
 * The bound is therefore per update: a render that changes no grid node can leave a cell held only while the program
 * keeps opening a newer update within each cap, which is as long as wterm itself keeps the screen frozen.
 */
export class HeldRelease {
  readonly #clock: ReleaseClock;
  readonly #release: () => void;
  #cancel: (() => void) | null = null;
  #since = 0;
  #generation = 0;

  constructor(clock: ReleaseClock, release: () => void) {
    this.#clock = clock;
    this.#release = release;
  }

  /** A cell is held now; arms the release unless one is armed already. */
  hold(): void {
    if (this.#cancel !== null) return;
    this.#since = this.#clock.now();
    if (this.#clock.synchronized()) this.#capped();
    else
      this.#cancel = this.#clock.frame(() => {
        this.#cancel = null;
        this.#since = this.#clock.now();
        if (this.#clock.synchronized()) this.#capped();
        else this.#release();
      });
  }

  /** The grid changed: the renderer painted, so whatever is held may go. */
  rendered(): void {
    this.cancel();
    this.#release();
  }

  cancel(): void {
    this.#cancel?.();
    this.#cancel = null;
  }

  #capped(): void {
    this.#generation = this.#clock.generation();
    const left = Math.max(0, this.#since + SYNCHRONIZED_HOLD_MS + SYNCHRONIZED_HOLD_MARGIN_MS - this.#clock.now());
    this.#cancel = this.#clock.timer(() => {
      this.#cancel = null;
      if (this.#clock.synchronized() && this.#clock.generation() !== this.#generation) {
        this.#since = this.#clock.now();
        this.#capped();
      } else this.#release();
    }, left);
  }
}
