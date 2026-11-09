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
  useEffect(() => {
    if (wt === null) return undefined;
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
      if (picked) openMenu.current({ x: event.clientX, y: event.clientY });
    };
    const onEnd = (event: TouchEvent): void => {
      // Only a press that selected something suppresses the tap's own mouse events; every other touch ends untouched.
      if (event.cancelable && longPressed(element)) event.preventDefault();
    };
    // Once the hold has picked its word the drag belongs to the selection, not to the scrollback: a cancelled
    // touchmove keeps the browser from taking the gesture (and the pointer events with it) as a pan.
    const onTouchMove = (event: TouchEvent): void => {
      if (press !== null && press.picked && event.cancelable) event.preventDefault();
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
    element.addEventListener("touchend", onEnd, { passive: false });
    element.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      stop();
      clearLongPress(element);
      element.removeEventListener("pointerdown", onDown, { capture: true });
      doc.removeEventListener("pointerdown", began, true);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", stop);
      element.removeEventListener("touchend", onEnd);
      element.removeEventListener("touchmove", onTouchMove);
    };
  }, [wt]);
}
