import type { TerminalHandle, WTerm } from "@wterm/react";
import { type RefObject, useEffect } from "react";
import { blinkCursor } from "./cursor-blink.ts";

/**
 * The terminal's cursor: its default shape written as the terminal's own state (programs still override it), and its
 * blink, flipped twice a second rather than animated every frame (cursor-blink.ts).
 */
export function useCursor(wt: WTerm | null, handle: RefObject<TerminalHandle | null>, sequence: string): void {
  useEffect(() => handle.current?.write(sequence), [wt, handle, sequence]);
  useEffect(() => (wt === null ? undefined : blinkCursor(wt.element)), [wt]);
}
