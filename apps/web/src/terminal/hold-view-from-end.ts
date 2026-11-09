import { type FrameTimer, nextFrame } from "./output-pacer.ts";

export interface EndHolder {
  readonly stop: () => void;
}

/** A scroller's view of its content: the hold is what moves `scrollTop`. */
interface Scroller {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** The replay's writer (the OutputPacer): the hold places the reader after each batch it writes has painted. */
export interface ReplayWriter {
  /** Whether output is still waiting to be written. */
  readonly busy: boolean;
  /** Runs `listener` after each batch is written to the terminal; returns how to stop. */
  onWrite(listener: () => void): () => void;
}

/**
 * Within this many pixels of a place is at it. @wterm/dom reads a view under 5px from its end as at the bottom
 * (`_isScrolledToBottom`, pinned by hold-view-from-end.test.ts); the app's own "away" decision and the hold's release use
 * the same line, or a reader 2-4px from the end would be held away from output wterm itself follows (#1394 review).
 */
export const END_TOLERANCE_PX = 5;

const maxScrollTop = (scroller: Scroller): number => scroller.scrollHeight - scroller.clientHeight;

const within = (a: number, b: number): boolean => Math.abs(a - b) < END_TOLERANCE_PX;

/**
 * How far above its end a scroller's reader is, in pixels; 0 at the end (#1040, #1393). Measured BEFORE a reattach's
 * reset empties the buffer: after it, every scroller reads as at the end, and a reader up in history would be dragged
 * down by the replay.
 */
export const fromEndOf = (scroller: Scroller): number => {
  const max = maxScrollTop(scroller);
  return within(scroller.scrollTop, max) ? 0 : max - scroller.scrollTop;
};

/**
 * Puts a scroller's reader `fromEnd` pixels above its end after the reset the caller just wrote paints, and again after
 * each batch of the reattach replay paints: at the end for a reader who was following (#1040), where they were in history
 * for one who was not (#1393). It ends once a batch has been written and the last one has painted with nothing left to
 * write, and sooner if the reader scrolls away from where it put them.
 *
 * Each write paints on the next animation frame (@wterm/dom books its render inside write()), so a frame booked right
 * after the write runs after that paint's layout: the position is set on the geometry the write produced. A hold that
 * ran a frame of its own and stopped when the writer went idle placed the reader on the batch before last (#1394). The
 * reset's paint matters too: wterm keeps the old rows in the DOM until the replay redraws them and scrolls to 0, so
 * for one frame the reader would see the top of the stale history.
 */
export function holdFromEnd(
  scroller: Scroller,
  replay: ReplayWriter,
  fromEnd: number,
  frame: FrameTimer = nextFrame,
): EndHolder {
  let cancelFrame: (() => void) | null = null;
  let unlisten: (() => void) | null = null;
  let written = false;
  // Where the hold last left the scroller; null until it has moved it. The reset renders before any batch and may
  // collapse the scroller, so a position the hold never wrote is not a reader scrolling away.
  let wrote: number | null = null;
  const stop = (): void => {
    cancelFrame?.();
    cancelFrame = null;
    unlisten?.();
    unlisten = null;
  };
  const place = (): void => {
    cancelFrame = null;
    const max = maxScrollTop(scroller);
    const target = Math.max(0, max - fromEnd);
    // With no history there is nowhere to have scrolled away to: the reset's collapse reads as this, and the hold goes
    // on from it. Only a position the hold wrote, and the reader then moved while history is above, lets go; wterm's
    // own follow lands at the target, which is not a reader moving.
    const canScrollAway = !within(max, 0);
    const moved = wrote !== null && !within(scroller.scrollTop, wrote) && !within(scroller.scrollTop, target);
    if (canScrollAway && moved) return stop();
    scroller.scrollTop = target;
    // What the element accepted, not what was written: a real scroller clamps to its content.
    wrote = scroller.scrollTop;
    if (written && !replay.busy) stop();
  };
  const book = (): void => {
    cancelFrame?.();
    cancelFrame = frame(place);
  };
  unlisten = replay.onWrite(() => {
    written = true;
    book();
  });
  book();
  return { stop };
}
