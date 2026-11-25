import { type Finger, pinchedSize, TwoFingerDoubleTap } from "./pinch-font.ts";

export interface PinchHooks {
  /** The size the terminal draws at now, read as a pinch begins. */
  readonly current: () => number;
  /** Draws the terminal at `size` without changing its grid: called once per step while the fingers move. */
  readonly preview: (size: number) => void;
  /** The fingers of a pinch lifted, before any commit: the preview ends. */
  readonly release: () => void;
  /** The pinch ended at a new size: called once, on release. */
  readonly commit: (size: number) => void;
  /** A two-finger double tap: back to the device's default. */
  readonly reset: () => void;
  readonly now?: () => number;
}

const isTouch = (event: Event): event is TouchEvent => "touches" in event;

const fingersOf = (event: Event): readonly Finger[] =>
  isTouch(event) ? Array.from(event.touches, (touch) => ({ x: touch.clientX, y: touch.clientY })) : [];

const apart = ([a, b]: readonly Finger[]): number =>
  a === undefined || b === undefined ? 0 : Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Two fingers on the terminal change its font size, never the page's zoom (the stylesheet leaves the terminal no
 * pinch-zoom). The glyphs follow the fingers a step at a time and the size is committed once as the fingers lift, so the
 * grid, and the program's columns, change once. One finger is left to the scroll and swipe handlers. Each step redraws
 * the rows, often the very cells the fingers came down on, and the browser keeps sending a touch's moves and lift to the
 * node it began on even once it has left the terminal (#2054): so each finger's node is followed itself, as
 * touch-wheel.ts does, or the lift is never heard.
 */
export function attachPinchZoom(element: EventTarget, hooks: PinchHooks): () => void {
  const now = hooks.now ?? (() => performance.now());
  const taps = new TwoFingerDoubleTap();
  let pinch: { readonly from: number; readonly start: number; size: number } | null = null;
  const followed = new Set<EventTarget>();
  const release = (): void => {
    for (const target of followed) {
      target.removeEventListener("touchmove", onMove);
      target.removeEventListener("touchend", onEnd);
      target.removeEventListener("touchcancel", onEnd);
    }
    followed.clear();
  };
  const follow = (target: EventTarget | null): void => {
    if (target === null || followed.has(target)) return;
    followed.add(target);
    target.addEventListener("touchmove", onMove, { passive: false });
    target.addEventListener("touchend", onEnd);
    target.addEventListener("touchcancel", onEnd);
  };
  const onStart = (event: Event): void => {
    if (fingersOf(event).length === 1) release();
    follow(event.target);
    const fingers = fingersOf(event);
    taps.start(fingers, now());
    const from = apart(fingers);
    pinch = fingers.length === 2 && from > 0 ? { from, start: hooks.current(), size: hooks.current() } : null;
  };
  // A touch that bubbles from one followed node to another is still one touch.
  const heard = new WeakSet<Event>();
  function onMove(event: Event): void {
    if (heard.has(event)) return;
    heard.add(event);
    const fingers = fingersOf(event);
    taps.move(fingers);
    if (pinch === null || fingers.length !== 2) return;
    if (event.cancelable) event.preventDefault();
    const size = pinchedSize(pinch.start, pinch.from, apart(fingers));
    if (size === pinch.size) return;
    pinch.size = size;
    hooks.preview(size);
  }
  function onEnd(event: Event): void {
    if (heard.has(event)) return;
    heard.add(event);
    const remaining = fingersOf(event).length;
    if (remaining === 0) release();
    const doubleTapped = taps.end(remaining, now());
    if (pinch !== null && remaining < 2) {
      const { start, size } = pinch;
      pinch = null;
      hooks.release();
      if (size !== start) hooks.commit(size);
    }
    if (doubleTapped) hooks.reset();
  }
  element.addEventListener("touchstart", onStart, { passive: true });
  return () => {
    element.removeEventListener("touchstart", onStart);
    release();
  };
}
