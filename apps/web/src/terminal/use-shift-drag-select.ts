import type { WTerm } from "@wterm/react";
import { useEffect } from "react";
import { holdSelection, releaseSelection } from "./held-selection.ts";
import { type Caret, caretAt, rangeBetween } from "./long-press.ts";

/**
 * Shift and a drag with the primary button select the view's text whatever the program asked of the mouse, as in
 * Ghostty and xterm. wterm already leaves a shift press to the browser (no report reaches the program), but the browser
 * gives Shift+mousedown a meaning of its own: extend the selection that exists. That selection is the caret inside the
 * renderer's focused textarea, and a selection cannot extend from an editable caret into the non-editable rows, so the
 * drag selected nothing. The press is cancelled instead, which keeps the textarea's focus (and a tablet's keyboard),
 * and the drag's range is built from the rows' own geometry and held by the view (held-selection.ts): painted as whole
 * cells (#410), copied by every copy path, and never a document selection, so the input method keeps composing (#592).
 */
export function useShiftDragSelect(wt: WTerm | null): void {
  useEffect(() => {
    if (wt === null) return undefined;
    const element = wt.element;
    const doc = element.ownerDocument;
    let anchor: Caret | null = null;
    const select = (event: MouseEvent): void => {
      if (anchor === null) return;
      const caret = caretAt(element, { x: event.clientX, y: event.clientY });
      if (caret === null) return;
      const range = rangeBetween(doc, anchor, caret);
      if (range === null || range.collapsed) releaseSelection(element);
      else holdSelection(element, range);
    };
    const stop = (): void => {
      anchor = null;
      window.removeEventListener("mousemove", select);
      window.removeEventListener("mouseup", onUp);
    };
    const onUp = (event: MouseEvent): void => {
      select(event);
      stop();
    };
    const onDown = (event: MouseEvent): void => {
      // Alt is wterm's rectangle drag; Ctrl or Cmd with Shift stay the browser's and the program's.
      if (event.button !== 0 || !event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
      const caret = caretAt(element, { x: event.clientX, y: event.clientY });
      if (caret === null) return;
      anchor = caret;
      event.preventDefault();
      window.addEventListener("mousemove", select);
      window.addEventListener("mouseup", onUp);
    };
    // wterm selects a word or line on a double or triple click whatever Shift says; that would add its own selection
    // beside the held one, so a shift multi-click is cancelled (wterm skips a click whose default is prevented).
    const onClick = (event: MouseEvent): void => {
      if (event.shiftKey && event.detail >= 2) event.preventDefault();
    };
    element.addEventListener("mousedown", onDown, { capture: true });
    element.addEventListener("click", onClick, { capture: true });
    window.addEventListener("blur", stop);
    return () => {
      stop();
      element.removeEventListener("mousedown", onDown, { capture: true });
      element.removeEventListener("click", onClick, { capture: true });
      window.removeEventListener("blur", stop);
    };
  }, [wt]);
}
