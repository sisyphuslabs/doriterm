import type { TerminalHandle } from "@wterm/react";
import { type RefObject, useEffect, useMemo } from "react";
import type { TerminalInput } from "./terminal-view.tsx";

export interface TerminalPort {
  /** The view's input path, so keys queue through a reconnect in order with typed input. */
  readonly send: (data: TerminalInput) => void;
  /** Pastes as a clipboard paste does: bracketed when the program asked, and through clipboard-paste-protection. */
  readonly paste: (text: string) => void;
  readonly focus: () => void;
}

function pasteInto(element: HTMLElement, text: string): void {
  const data = new DataTransfer();
  data.setData("text/plain", text);
  const target = element.querySelector("textarea") ?? element;
  target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
}

export function useTerminalPort(
  handle: RefObject<TerminalHandle | null>,
  send: (data: TerminalInput) => void,
  onPort: ((port: TerminalPort | null) => void) | undefined,
): void {
  const port = useMemo<TerminalPort>(
    () => ({
      send,
      paste: (text) => {
        const element = handle.current?.instance?.element;
        if (element !== undefined) pasteInto(element, text);
      },
      focus: () => handle.current?.focus(),
    }),
    [handle, send],
  );
  useEffect(() => {
    onPort?.(port);
    return () => onPort?.(null);
  }, [onPort, port]);
}
