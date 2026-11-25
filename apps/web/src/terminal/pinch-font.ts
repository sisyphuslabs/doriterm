/** The terminal sizes a pinch reaches, in points: 8 pt still shows 80 columns on a phone, as the redesign asks. */
export const PINCH_MIN_PT = 8;
export const PINCH_MAX_PT = 24;
const STEP_PT = 0.5;
/** Each x1.06 of finger distance is one step, so a pinch feels the same at any size (log scale). */
const STEP_RATIO = 1.06;

const onGrid = (size: number): number => Math.round(size / STEP_PT) * STEP_PT;

/** The size a pinch that began at `start` with the fingers `from` apart reaches with them `to` apart. */
export function pinchedSize(start: number, from: number, to: number): number {
  const steps = Math.trunc(Math.log(to / from) / Math.log(STEP_RATIO));
  return Math.min(PINCH_MAX_PT, Math.max(PINCH_MIN_PT, onGrid(start) + steps * STEP_PT));
}

export interface Finger {
  readonly x: number;
  readonly y: number;
}

/** Longest a two-finger tap may stay down, and longest between the two taps. */
const TAP_MS = 250;
const BETWEEN_MS = 350;
/** Travel past which the fingers are pinching or panning, not tapping. */
const SLOP_PX = 12;

/**
 * Tells a two-finger double tap apart from a pinch, a pan and a one-finger double tap: two fingers land, lift within
 * 250 ms having moved no more than 12 px, and do it again within 350 ms. A reset uses the pair up.
 */
export class TwoFingerDoubleTap {
  #down: { readonly at: number; readonly fingers: readonly Finger[]; moved: boolean } | null = null;
  #lastTap: number | null = null;

  start(fingers: readonly Finger[], at: number): boolean {
    if (fingers.length === 2) this.#down = { at, fingers, moved: false };
    else if (fingers.length > 2) this.#down = null;
    return false;
  }

  move(fingers: readonly Finger[]): void {
    const down = this.#down;
    if (down === null) return;
    const travelled = fingers.some((finger, index) => {
      const from = down.fingers[index];
      return from === undefined || Math.hypot(finger.x - from.x, finger.y - from.y) > SLOP_PX;
    });
    if (travelled) down.moved = true;
  }

  /** The last finger lifted at `at`; true when this lift completes a double tap. */
  end(remaining: number, at: number): boolean {
    const down = this.#down;
    if (remaining > 0 || down === null) return false;
    this.#down = null;
    if (down.moved || at - down.at > TAP_MS) {
      this.#lastTap = null;
      return false;
    }
    if (this.#lastTap !== null && down.at - this.#lastTap <= BETWEEN_MS) {
      this.#lastTap = null;
      return true;
    }
    this.#lastTap = at;
    return false;
  }
}
