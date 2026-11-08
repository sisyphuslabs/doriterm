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
}

export function pasteInto(element: HTMLElement, text: string): void {
  const data = new DataTransfer();
  data.setData("text/plain", text);
  const target = element.querySelector("textarea") ?? element;
  target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
}

/** The port over a terminal view: every paste sends a syllable still composing first, so it lands where it was typed. */
export function portOf(
  handle: RefObject<TerminalHandle | null>,
  send: (data: TerminalInput) => void,
  pasteFiles: (files: readonly File[]) => void,
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
    focus: () => handle.current?.focus(),
  };
}

export function useTerminalPort(
  handle: RefObject<TerminalHandle | null>,
  send: (data: TerminalInput) => void,
  onPort: ((port: TerminalPort | null) => void) | undefined,
  pasteFiles: (files: readonly File[]) => void,
): void {
  const port = useMemo(() => portOf(handle, send, pasteFiles), [handle, send, pasteFiles]);
  useEffect(() => {
    onPort?.(port);
    return () => onPort?.(null);
  }, [onPort, port]);
}
