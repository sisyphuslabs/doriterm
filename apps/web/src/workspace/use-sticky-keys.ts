import { useToastManager } from "@doriface/ui";
import { type RefObject, useState } from "react";
import { applyModifiers, type HostPlatform, keySequence, MODIFIERS } from "../terminal/keys.ts";
import type { TerminalPort } from "../terminal/terminal-port.ts";
import { readClipboard } from "../terminal/paste-files.ts";

export interface StickyKeys {
  readonly latched: ReadonlySet<string>;
  /** Applies the latched modifiers to typed input and lets them go; the paste chord pastes and sends nothing. */
  readonly transform: (data: string) => string;
  readonly press: (id: string) => void;
  /** Sends the bytes a key carries (a pack's key, or one of the person's own), through the latched modifiers. */
  readonly send: (bytes: string) => void;
  readonly paste: () => void;
}

/** What one press sends: the key's bytes through the latched modifiers, or a paste instead of a write. */
export function sentBy(
  bytes: string,
  latched: ReadonlySet<string>,
  host: HostPlatform,
): { readonly kind: "write"; readonly data: string } | { readonly kind: "paste" } {
  if (latched.size === 0) return { kind: "write", data: bytes };
  const input = applyModifiers(bytes, latched, host);
  return input.kind === "write" ? { kind: "write", data: input.data } : { kind: "paste" };
}

/** The phone's modifiers as t3code has them: tap to latch, applied to the next key or typed character, then off. */
export function useStickyKeys(port: RefObject<TerminalPort | null>, host: HostPlatform): StickyKeys {
  const [latched, setLatched] = useState<ReadonlySet<string>>(new Set());
  const toasts = useToastManager();
  const pasteClipboard = (): void => {
    // A browser without the clipboard API throws instead of rejecting, so the call runs inside the promise chain.
    void Promise.resolve()
      .then(() => readClipboard(navigator.clipboard))
      .then(
        (read) => ("files" in read ? port.current?.pasteFiles(read.files) : port.current?.paste(read.text)),
        () => toasts.add({ type: "warning", title: "Paste needs access to the clipboard" }),
      );
  };
  const transform = (data: string): string => {
    if (latched.size === 0) return data;
    setLatched(new Set());
    const sent = sentBy(data, latched, host);
    if (sent.kind === "write") return sent.data;
    pasteClipboard();
    return "";
  };
  const send = (bytes: string): void => {
    const input = transform(bytes);
    if (input !== "") port.current?.send(input);
  };
  const press = (id: string): void => {
    if (MODIFIERS.has(id)) {
      // A syllable still composing was typed before the modifier: it goes now, without it (#652).
      port.current?.commitComposition();
      setLatched((prev) => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
      });
      return;
    }
    const sequence = keySequence(id);
    if (sequence !== undefined) send(sequence);
  };
  const paste = (): void => {
    setLatched(new Set());
    pasteClipboard();
  };
  return { latched, transform, press, send, paste };
}
