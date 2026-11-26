import { useCallback, useEffect } from "react";
import type { TerminalInput } from "./terminal-view-props.ts";

export interface TypedInto {
  typed(): void;
}

/**
 * The person's own typing in the terminal: keys, text a soft keyboard or an IME puts in, and a paste. Not the terminal's
 * answers to a program's queries, which reach the same onData as typed keys (#2794).
 */
const TYPING_EVENTS = ["keydown", "beforeinput", "paste"] as const;

/** Lets `output`'s held replay go as the person types anywhere in `target`; returns how to stop. */
export function typingEndsReplay(target: EventTarget, output: TypedInto): () => void {
  const typed = (): void => output.typed();
  const options = { capture: true, passive: true };
  for (const type of TYPING_EVENTS) target.addEventListener(type, typed, options);
  return () => {
    for (const type of TYPING_EVENTS) target.removeEventListener(type, typed, options);
  };
}

/**
 * A replay held for its paint never holds back what the person types (#2794): typing in the terminal lets it go, and so
 * does input sent from outside it (the key bar, the input card, a confirmed paste), through the `typed` this returns.
 */
export function useTypingEndsReplay(
  terminal: { readonly element: HTMLElement } | null,
  output: TypedInto,
  typed: (data: TerminalInput) => void,
): (data: TerminalInput) => void {
  useEffect(() => (terminal === null ? undefined : typingEndsReplay(terminal.element, output)), [terminal, output]);
  return useCallback(
    (data: TerminalInput): void => {
      output.typed();
      typed(data);
    },
    [output, typed],
  );
}
