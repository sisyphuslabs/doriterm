import type { WTerm } from "@wterm/react";
import { useEffect } from "react";
import { copiedText } from "./copied-text.ts";
import { heldSelection, holdSelection, releaseSelection } from "./held-selection.ts";
import { longPressed } from "./long-press.ts";
import { mayTakeFocus } from "./may-take-focus.ts";

/** Keys that leave the held selection for a copy that is about to read it. */
function keepsSelection(event: KeyboardEvent): boolean {
  if (/^(Shift|Control|Alt|Meta|AltGraph|CapsLock|Fn)$/.test(event.key)) return true;
  return copies(event);
}

/** The chords WTerm itself reads as a copy while it has a selection: Cmd+C, or Ctrl+C where it is not the program's. */
function copies(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "c";
}

/**
 * Dragging across the rows selects their text natively, and the browser moves focus to the page body
 * on the way, so keys typed next went nowhere. When a press that started here ends (wherever the
 * pointer is by then) with focus outside the terminal, focus goes back to its input. A modal that opened meanwhile (a
 * question asked from the keyboard while the button was down) keeps the keyboard.
 *
 * A double or triple click selects a word or line in wterm's own click handler, after that mouseup, and wterm blurs its
 * input as it does: the same restore runs again on that click (#516). wterm's handler was added first, so it has run.
 * A held finger's selection (use-long-press-select.ts, #195) is not the press's to drop: the mouse events a tap
 * synthesizes after it arrive with the range already held, and they leave it alone.
 */
export function useFocusAfterSelect(wt: WTerm | null, trimCopy: boolean): void {
  useEffect(() => {
    if (wt === null) return undefined;
    const element = wt.element;
    const document = element.ownerDocument;
    const restore = (): void => {
      if (element.contains(document.activeElement) || !element.isConnected || !mayTakeFocus(element)) return;
      const selection = document.getSelection();
      const range = selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
      // The selection is emptied before the input takes focus, so focusing puts the input's caret back as the document's
      // selection. Emptied after, the input keeps focus with no caret, and macOS's Korean input method commits each jamo.
      if (!longPressed(element)) keepPressSelection(selection, element, range);
      wt.focus();
    };
    const press = (event: MouseEvent): void => {
      if (event.button === 0) document.addEventListener("mouseup", restore, { once: true });
    };
    const multiClick = (event: MouseEvent): void => {
      if (event.button === 0 && event.detail >= 2) restore();
    };
    const drop = (): void => releaseSelection(element);
    const buttonDown = (event: MouseEvent): void => {
      if (event.button !== 0 || longPressed(element)) return;
      // A press in a menu or a dialog is acting on the selection its items show, not leaving it.
      if (
        event.target instanceof Element &&
        event.target.closest("[role=menu],[role=dialog],[role=alertdialog]") !== null
      )
        return;
      drop();
    };
    const copy = (event: ClipboardEvent): void => {
      const held = heldSelection(element);
      if (held === null || event.defaultPrevented || event.clipboardData === null) return;
      const selection = document.getSelection();
      if (selection !== null && !selection.isCollapsed) return;
      event.clipboardData.setData("text/plain", copiedText(held.text, trimCopy));
      event.preventDefault();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!keepsSelection(event)) {
        drop();
        return;
      }
      if (!copies(event)) return;
      const held = heldSelection(element);
      if (held === null) return;
      const selection = document.getSelection();
      if (selection !== null && !selection.isCollapsed) return;
      // WTerm copies Ctrl+C only while its own, native selection exists. The held one replaces it, so the key is
      // answered here instead of reaching the program as ^C.
      event.preventDefault();
      event.stopPropagation();
      void navigator.clipboard?.writeText(copiedText(held.text, trimCopy)).catch(() => undefined);
    };
    const selectionChanged = (): void => {
      const selection = document.getSelection();
      if (selection !== null && !selection.isCollapsed) drop();
    };
    element.addEventListener("mousedown", press);
    element.addEventListener("click", multiClick);
    document.addEventListener("mousedown", buttonDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("selectionchange", selectionChanged);
    document.addEventListener("copy", copy);
    return () => {
      element.removeEventListener("mousedown", press);
      element.removeEventListener("click", multiClick);
      document.removeEventListener("mouseup", restore);
      document.removeEventListener("mousedown", buttonDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("selectionchange", selectionChanged);
      document.removeEventListener("copy", copy);
      releaseSelection(element);
    };
  }, [wt, trimCopy]);
}

/**
 * The press's selection is held by the terminal, never put back into the document. Focusing the input is what keeps
 * the keyboard (#516); a non-collapsed document selection over the rows, though, makes the browser treat the focused
 * input as a non-editable selection, and the OS input method stops starting compositions: every Hangul keystroke then
 * arrives as its own jamo (#592). The held range is painted as the same cells and copied as the same text.
 */
export function keepPressSelection(selection: Selection | null, element: Element, range: Range | null): void {
  if (range === null || range.collapsed) {
    releaseSelection(element);
    return;
  }
  selection?.removeAllRanges();
  holdSelection(element, range);
}
