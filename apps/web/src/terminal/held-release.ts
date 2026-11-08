/** Longest a confirmed cell stays held while the program keeps a synchronized update open: wterm's own hold (1000 ms). */
export const SYNCHRONIZED_HOLD_MS = 1000;

/** What the release reads and schedules with; the hook passes the browser's, a test passes fakes. */
export interface ReleaseClock {
  now(): number;
  frame(run: () => void): () => void;
  timer(run: () => void, ms: number): () => void;
  /** The program has a synchronized update (DECSET 2026) open, so the renderer may not paint its writes yet. */
  synchronized(): boolean;
}

/**
 * When the overlay lets go of a cell it holds over an echo the renderer has not painted yet (design review HIGH 4,
 * #1439). A grid change means the renderer painted: release at once. Otherwise the renderer paints a write on the next
 * frame, so release then, unless the program has a synchronized update open: wterm then paints nothing until the update
 * ends (or its own 1000 ms fallback fires), which changes the grid; releasing on the next frame instead would blank the
 * cell for as long as the update lasts. That wait is capped at SYNCHRONIZED_HOLD_MS from when the hold began, so a
 * render that changes no grid node can never leave a cell held for good.
 */
export class HeldRelease {
  readonly #clock: ReleaseClock;
  readonly #release: () => void;
  #cancel: (() => void) | null = null;
  #since = 0;

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
    const left = Math.max(0, this.#since + SYNCHRONIZED_HOLD_MS - this.#clock.now());
    this.#cancel = this.#clock.timer(() => {
      this.#cancel = null;
      this.#release();
    }, left);
  }
}
