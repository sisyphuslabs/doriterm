import { useToastManager } from "@doriface/ui";
import { type RefObject, useState } from "react";
import { applyModifiers, type HostPlatform, keySequence, MODIFIERS } from "../terminal/keys.ts";
import type { TerminalPort } from "../terminal/terminal-port.ts";

export interface StickyKeys {
  readonly latched: ReadonlySet<string>;
  /** Applies the latched modifiers to typed input and lets them go; the paste chord pastes and sends nothing. */
  readonly transform: (data: string) => string;
  readonly press: (id: string) => void;
  readonly paste: () => void;
}

/** The phone's modifiers as t3code has them: tap to latch, applied to the next key or typed character, then off. */
export function useStickyKeys(port: RefObject<TerminalPort | null>, host: HostPlatform): StickyKeys {
  const [latched, setLatched] = useState<ReadonlySet<string>>(new Set());
  const toasts = useToastManager();
  const pasteClipboard = (): void => {
    // A browser without the clipboard API throws instead of rejecting, so the call runs inside the promise chain.
    void Promise.resolve()
      .then(() => navigator.clipboard.readText())
      .then(
        (text) => port.current?.paste(text),
        () => toasts.add({ type: "warning", title: "Paste needs access to the clipboard" }),
      );
  };
  const transform = (data: string): string => {
    if (latched.size === 0) return data;
    setLatched(new Set());
    const input = applyModifiers(data, latched, host);
    if (input.kind === "write") return input.data;
    pasteClipboard();
    return "";
  };
  const press = (id: string): void => {
    if (MODIFIERS.has(id)) {
      setLatched((prev) => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
      });
      return;
    }
    const sequence = keySequence(id);
    if (sequence === undefined) return;
    const input = transform(sequence);
    if (input !== "") port.current?.send(input);
  };
  const paste = (): void => {
    setLatched(new Set());
    pasteClipboard();
  };
  return { latched, transform, press, paste };
}
