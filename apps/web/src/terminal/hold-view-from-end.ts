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

/** The reader's own input on the terminal: the only thing that ends a hold before the replay does. */
export interface ReaderInput {
  /** Runs `listener` when the reader scrolls, touches, clicks or types; returns how to stop. */
  onInput(listener: () => void): () => void;
}

/** Every way a reader moves the view themselves: the wheel, a touch, a pointer (the scrollbar's drag) and the keys. */
const READER_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/** The reader's input anywhere in `target`: the terminal and what overlays it, its scrollbar included. */
export const readerInputOn = (target: EventTarget): ReaderInput => ({
  onInput: (listener) => {
    const options = { capture: true, passive: true };
    for (const type of READER_EVENTS) target.addEventListener(type, listener, options);
    return () => {
      for (const type of READER_EVENTS) target.removeEventListener(type, listener, options);
    };
  },
});

/**
 * Puts a scroller's reader `fromEnd` pixels above its end after the reset the caller just wrote paints, and again after
 * each batch of the reattach replay paints: at the end for a reader who was following (#1040), where they were in history
 * for one who was not (#1393). It ends once a batch has been written and the last one has painted with nothing left to
 * write, and sooner when the reader scrolls, touches, clicks or types.
 *
 * Only the reader's input ends it early, never a position: the terminal moves the scroller itself during a reattach (its
 * reset's render scrolls to the top, and that render can land after the hold has placed the reader), and reading that
 * move as the reader's own left them at the top of the history (#1394).
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
  reader: ReaderInput,
  frame: FrameTimer = nextFrame,
): EndHolder {
  let cancelFrame: (() => void) | null = null;
  let unlisten: (() => void) | null = null;
  let unlistenReader: (() => void) | null = null;
  let written = false;
  const stop = (): void => {
    cancelFrame?.();
    cancelFrame = null;
    unlisten?.();
    unlisten = null;
    unlistenReader?.();
    unlistenReader = null;
  };
  const place = (): void => {
    cancelFrame = null;
    scroller.scrollTop = Math.max(0, maxScrollTop(scroller) - fromEnd);
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
  unlistenReader = reader.onInput(stop);
  book();
  return { stop };
}
