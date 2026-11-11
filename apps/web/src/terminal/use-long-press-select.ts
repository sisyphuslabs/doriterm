import type { WTerm } from "@wterm/react";
import { useEffect, useRef } from "react";
import { holdSelection } from "./held-selection.ts";
import {
  caretAt,
  clearLongPress,
  extendSelection,
  LONG_PRESS_MS,
  LONG_PRESS_SLOP,
  longPressed,
  markLongPress,
  type Point,
  type Word,
  wordRangeAt,
} from "./long-press.ts";

/** A followed node is any EventTarget, so its listeners take any event: a touch one carries its fingers. */
const isTouch = (event: Event): event is TouchEvent => "touches" in event;

interface Press {
  readonly pointer: number;
  readonly from: Point;
  picked: boolean;
  word: Word | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * A held finger on the terminal selects the word under it and drags the selection out from that word, and lifting the
 * finger offers Copy and Paste where it lifted (#664). Before the hold is up a moving finger is a scroll or a tap and
 * this keeps its hands off. The rows are not natively selectable under a coarse pointer (render-css.ts), so no browser
 * callout competes with the drag, and the selection lives in the terminal's held range (held-selection.ts) rather than
 * the document's, so the cells are painted and copied as a selection while the input method still composes Hangul
 * (#592).
 */
export function useLongPressSelect(wt: WTerm | null, onMenu: (at: Point | null) => void): void {
  const openMenu = useRef(onMenu);
  openMenu.current = onMenu;
  useEffect(() => (wt === null ? undefined : attachLongPressSelect(wt, (at) => openMenu.current(at))), [wt]);
}

/**
 * Wires one terminal for the held-press selection the hook above describes and returns what unwires it. Apart from the
 * hook so its gestures can be driven without a renderer (#854).
 */
export function attachLongPressSelect(wt: Pick<WTerm, "element">, openMenu: (at: Point | null) => void): () => void {
  const element = wt.element;
  const doc = element.ownerDocument;
  let press: Press | null = null;
  const stop = (): void => {
    if (press !== null && press.timer !== null) clearTimeout(press.timer);
    press = null;
  };
  const pick = (): void => {
    const picked = press === null ? null : wordRangeAt(element, press.from);
    if (picked === null || press === null) return;
    press.picked = true;
    press.word = picked.word;
    holdSelection(element, picked.range);
    markLongPress(element);
  };
  const onDown = (event: PointerEvent): void => {
    if (event.pointerType !== "touch" || !event.isPrimary || press !== null) return;
    const timer = setTimeout(pick, LONG_PRESS_MS);
    press = {
      pointer: event.pointerId,
      from: { x: event.clientX, y: event.clientY },
      picked: false,
      word: null,
      timer,
    };
  };
  const onMove = (event: PointerEvent): void => {
    if (press === null || event.pointerId !== press.pointer) return;
    if (!press.picked) {
      const moved = Math.hypot(event.clientX - press.from.x, event.clientY - press.from.y);
      if (moved > LONG_PRESS_SLOP) stop();
      return;
    }
    const caret = caretAt(element, { x: event.clientX, y: event.clientY });
    if (caret === null || press.word === null) return;
    const range = extendSelection(doc, press.word, caret);
    if (range !== null) holdSelection(element, range);
  };
  const onUp = (event: PointerEvent): void => {
    if (press === null || event.pointerId !== press.pointer) return;
    const picked = press.picked;
    stop();
    if (picked) openMenu({ x: event.clientX, y: event.clientY });
  };
  const onEnd = (event: Event): void => {
    // Only a press that selected something suppresses the tap's own mouse events; every other touch ends untouched.
    if (event.cancelable && longPressed(element)) event.preventDefault();
    if (!isTouch(event) || event.touches.length === 0) release();
  };
  // Once the hold has picked its word the drag belongs to the selection, not to the scrollback: a cancelled
  // touchmove keeps the browser from taking the gesture (and the pointer events with it) as a pan.
  const onTouchMove = (event: Event): void => {
    if (press !== null && press.picked && event.cancelable) event.preventDefault();
  };
  /**
   * The nodes the fingers came down on. The browser sends each touch's moves and lift to the node that finger landed on
   * alone, even once the program has redrawn it out of the terminal, where they no longer bubble (#2057, as #2054 for the
   * swipe): so they are followed on those nodes themselves. Every finger's: a second finger's moves go to its own node,
   * and one left to the browser would let it take the pair as a pinch and cancel the drag (#2096).
   */
  const touched = new Set<EventTarget>();
  const follow = (target: EventTarget | null): void => {
    if (target === null || touched.has(target)) return;
    touched.add(target);
    target.addEventListener("touchmove", onTouchMove, { passive: false });
    target.addEventListener("touchend", onEnd, { passive: false });
    target.addEventListener("touchcancel", onEnd);
  };
  const release = (): void => {
    for (const target of touched) {
      target.removeEventListener("touchmove", onTouchMove);
      target.removeEventListener("touchend", onEnd);
      target.removeEventListener("touchcancel", onEnd);
    }
    touched.clear();
  };
  const onTouchStart = (event: TouchEvent): void => {
    // A touch that begins with no finger down is a gesture of its own: the last one's nodes are let go first.
    if (event.touches.length === 1) release();
    follow(event.target);
  };
  // The mark belongs to one touch, and the next press anywhere answers for its own tap. A finger still down is that
  // press, so a second one beside it leaves the mark alone.
  const began = (): void => {
    if (press === null) clearLongPress(element);
  };
  // Capture: the renderer's input textarea sits over the cursor's cell and answers a press itself, so a press there
  // would never reach a listener on the terminal's element on the way up.
  element.addEventListener("pointerdown", onDown, { capture: true });
  doc.addEventListener("pointerdown", began, true);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", stop);
  element.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
  return () => {
    stop();
    clearLongPress(element);
    element.removeEventListener("pointerdown", onDown, { capture: true });
    doc.removeEventListener("pointerdown", began, true);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", stop);
    element.removeEventListener("touchstart", onTouchStart, { capture: true });
    release();
  };
}
