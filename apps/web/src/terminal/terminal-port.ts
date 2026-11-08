import type { TerminalHandle } from "@wterm/react";
import { type RefObject, useEffect, useMemo } from "react";
import type { TerminalInput } from "./terminal-view-props.ts";

export interface TerminalPort {
  /** The view's input path, so keys queue through a reconnect in order with typed input. */
  readonly send: (data: TerminalInput) => void;
  /** Pastes as a clipboard paste does: bracketed when the program asked, and through clipboard-paste-protection. */
  readonly paste: (text: string) => void;
  /** Puts files on the terminal's machine and pastes their paths, as a pasted image does (#701). */
  readonly pasteFiles: (files: readonly File[]) => void;
  /**
   * Sends a syllable still composing in the terminal's field now, as typed, and ends that composition (#652): a
   * modifier latched after it applies to the next key only. `send`, `paste` and `pasteFiles` do this first themselves.
   */
  readonly commitComposition: () => void;
  readonly focus: () => void;
  /** Puts the soft keyboard down: the field asks for none again until the keys ask for one (#1375). */
  readonly quiet: () => void;
}

export function pasteInto(element: HTMLElement, text: string): void {
  const data = new DataTransfer();
  data.setData("text/plain", text);
  const target = element.querySelector("textarea") ?? element;
  target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
}

/** The renderer's own field, which @wterm/dom creates inside the terminal's element: the one a soft keyboard follows. */
const fieldOf = (handle: RefObject<TerminalHandle | null>): HTMLTextAreaElement | null => {
  const element = handle.current?.instance?.element;
  return element?.querySelector("textarea") ?? null;
};

/**
 * Lets the field under this terminal raise the soft keyboard, before the focus that reads it. On a surface that has one
 * the field carries `inputmode="none"`, so a press in the terminal raises nothing and only the keys ask for the keyboard
 * (#1375); a field that already has the focus is let go first, since a browser raises no keyboard for a focus it already
 * has. A surface with no soft keyboard to raise is left alone, and so is a hardware keyboard: `inputmode` is the soft
 * keyboard's own.
 */
export function askingForKeyboard(handle: RefObject<TerminalHandle | null>, softKeyboard: boolean): void {
  if (!softKeyboard) return;
  const field = fieldOf(handle);
  if (field === null) return;
  if (field.ownerDocument.activeElement === field) field.blur();
  field.inputMode = "text";
}

/**
 * Keeps the soft keyboard down under this terminal: while its field carries `inputmode="none"` a press in the terminal
 * raises nothing, which is what a touch surface wants (#1375). A field that has the focus is the one the keys just asked
 * for, so its mode is left to that ask.
 */
export function quietKeyboard(element: HTMLElement): void {
  const field = element.querySelector("textarea");
  if (!(field instanceof HTMLTextAreaElement)) return;
  if (field.ownerDocument.activeElement !== field) field.inputMode = "none";
}

/** The port over a terminal view: every paste sends a syllable still composing first, so it lands where it was typed. */
export function portOf(
  handle: RefObject<TerminalHandle | null>,
  send: (data: TerminalInput) => void,
  pasteFiles: (files: readonly File[]) => void,
  softKeyboard: boolean,
): TerminalPort {
  const commitComposition = (): void => {
    const preedit = handle.current?.instance?.takeComposition() ?? "";
    if (preedit !== "") send(preedit);
  };
  return {
    send,
    paste: (text) => {
      const element = handle.current?.instance?.element;
      if (element === undefined) return;
      commitComposition();
      pasteInto(element, text);
    },
    pasteFiles: (files) => {
      commitComposition();
      pasteFiles(files);
    },
    commitComposition,
    focus: () => {
      askingForKeyboard(handle, softKeyboard);
      handle.current?.focus();
    },
    quiet: () => {
      // A surface with no soft keyboard of its own (a mouse-only window) keeps its field as it is, for an OS on-screen
      // keyboard that reads it.
      if (!softKeyboard) return;
      const field = fieldOf(handle);
      // A field that has the focus is the one the keys just asked for: its mode is that ask's until it lets go.
      if (field !== null && field.ownerDocument.activeElement !== field) field.inputMode = "none";
    },
  };
}

export function useTerminalPort(
  handle: RefObject<TerminalHandle | null>,
  send: (data: TerminalInput) => void,
  onPort: ((port: TerminalPort | null) => void) | undefined,
  pasteFiles: (files: readonly File[]) => void,
  softKeyboard: boolean,
): void {
  const port = useMemo(() => portOf(handle, send, pasteFiles, softKeyboard), [handle, send, pasteFiles, softKeyboard]);
  useEffect(() => {
    onPort?.(port);
    return () => onPort?.(null);
  }, [onPort, port]);
}
