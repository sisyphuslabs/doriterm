import type { TerminalHandle, WTerm } from "@wterm/react";
import { type RefObject, useEffect, useRef } from "react";
import { keyboardIsIdle, mayTakeFocus } from "./may-take-focus.ts";

export interface KeyboardClaim {
  /** Whether the view is the focused pane, as of the last render. */
  readonly isFocused: RefObject<boolean>;
  /** The view in use takes keyboard focus once it is ready, unless a modal is open over it. */
  readonly focusWhenFree: (ready: WTerm) => void;
}

/**
 * When a view moves the keyboard into itself: as the focused pane, unless a modal is open, and from wherever the
 * keyboard is only when this page asked for its pane (`claimed`, see TerminalViewProps), else only from nowhere, and
 * never on a surface whose focus raises a soft keyboard the person did not ask for (`softKeyboard`, there).
 */
export function useKeyboardClaim(
  handle: RefObject<TerminalHandle | null>,
  focused: boolean,
  claimed: boolean,
  softKeyboard: boolean,
): KeyboardClaim {
  const isClaimed = useRef(claimed);
  isClaimed.current = claimed;
  const isSoftKeyboard = useRef(softKeyboard);
  isSoftKeyboard.current = softKeyboard;
  const mayTakeKeyboard = (element: HTMLElement): boolean =>
    !isSoftKeyboard.current && mayTakeFocus(element) && (isClaimed.current || keyboardIsIdle(element));

  // Becoming the focused pane (a tab closed, a split moved) takes keyboard focus, unless a modal is open over it.
  useEffect(() => {
    const instance = handle.current?.instance ?? null;
    if (focused && instance !== null && mayTakeKeyboard(instance.element)) instance.focus();
  }, [focused]);
  const isFocused = useRef(focused);
  useEffect(() => {
    isFocused.current = focused;
  }, [focused]);
  const focusWhenFree = (ready: WTerm): void => {
    if (isFocused.current && mayTakeKeyboard(ready.element)) ready.focus();
  };
  return { isFocused, focusWhenFree };
}
