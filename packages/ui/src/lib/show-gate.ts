/**
 * When a wait's indicator is on screen: only once the wait has lasted `delayMs`, so a short wait shows nothing, and then
 * for at least `minMs`, so an indicator that does appear never blinks out the moment it came (#2768). Nielsen's limits:
 * a wait under about a second needs no feedback, and a change faster than the eye can follow is noise.
 */
export interface ShowTiming {
  readonly delayMs: number;
  readonly minMs: number;
}

export class ShowGate {
  readonly #timing: ShowTiming;
  readonly #changed: (shown: boolean) => void;
  #active = false;
  #shown = false;
  #shownAt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(timing: ShowTiming, changed: (shown: boolean) => void) {
    this.#timing = timing;
    this.#changed = changed;
  }

  get shown(): boolean {
    return this.#shown;
  }

  /** The wait started (true) or ended (false). */
  set(active: boolean): void {
    if (active === this.#active) return;
    this.#active = active;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (active) {
      if (!this.#shown) this.#timer = setTimeout(() => this.#show(), this.#timing.delayMs);
      return;
    }
    if (!this.#shown) return;
    const left = this.#shownAt + this.#timing.minMs - Date.now();
    if (left <= 0) this.#hide();
    else this.#timer = setTimeout(() => this.#hide(), left);
  }

  stop(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#active = false;
  }

  #show(): void {
    this.#timer = undefined;
    this.#shown = true;
    this.#shownAt = Date.now();
    this.#changed(true);
  }

  #hide(): void {
    this.#timer = undefined;
    this.#shown = false;
    this.#changed(false);
  }
}
