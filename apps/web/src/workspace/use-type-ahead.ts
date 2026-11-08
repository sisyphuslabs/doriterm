import { useCallback, useEffect, useMemo, useRef } from "react";
import { useMouseOnly } from "../terminal/keyboard-inset.ts";
import { useNarrow } from "./use-narrow.ts";
import { type HeldInput, keyInit, replay, terminalInput } from "./type-ahead.ts";

/** Why held input was given up: the terminal did not start, or its view did not mount in time. */
export type DropReason = "failed" | "slow";

export interface TypeAhead {
  /** Takes the keyboard for a terminal being started, before its address is known; returns the hold. */
  readonly hold: () => number;
  /**
   * Hands the hold's input to the terminal at `address` once its view has mounted; the newest hold also gets focus,
   * except on a phone, where only the keys bar asks for the keyboard (#1375).
   */
  readonly deliver: (hold: number, address: string) => void;
  /** The terminal never came: focus goes back where it was, and input typed for it is reported as not sent. */
  readonly release: (hold: number) => void;
  /**
   * Whether the keyboard is still the terminal's at `address`: in the hold, on nothing, or in that terminal's own view.
   * False once the person has moved on (a menu, a dialog, another terminal), which a late answer must leave alone (#360).
   */
  readonly holds: (hold: number, address: string) => boolean;
  /** The element that holds the keyboard meanwhile; render it once, with `CATCHER_ATTRIBUTES`. */
  readonly catcher: React.RefObject<HTMLTextAreaElement | null>;
}

/** Marks the holding input, so an overlay's focus guard lets a terminal being started take the keyboard. */
export const TYPE_AHEAD_ATTRIBUTE = "data-type-ahead";

/** While no terminal is being started the holding input is out of the page: unfocusable and not announced. */
export const CATCHER_ATTRIBUTES = { [TYPE_AHEAD_ATTRIBUTE]: "", inert: true, "aria-hidden": true } as const;

/** How long a started terminal's view may take to mount before its held input is given up. */
export const MOUNT_BUDGET_MS = 15_000;
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock"]);

/** Whether the keyboard sits where a hold left it for the terminal at `address`. */
function keyboardStayed(catcher: HTMLTextAreaElement | null, address: string): boolean {
  const active = document.activeElement;
  if (active === null || active === document.body || active === catcher) return true;
  return active.closest(`[data-terminal="${CSS.escape(address)}"]`) !== null;
}

const awake = (input: HTMLTextAreaElement | null, on: boolean): void => {
  if (input === null) return;
  input.inert = !on;
  if (on) input.removeAttribute("aria-hidden");
  else input.setAttribute("aria-hidden", "true");
};

export function useTypeAhead(dropped: (reason: DropReason) => void): TypeAhead {
  const narrow = useNarrow();
  const mouseOnly = useMouseOnly();
  // Below the desktop layout's width on a device with a soft keyboard, the hold waits for the terminal without taking
  // the keyboard, on the way in or on handover: opening a terminal would otherwise raise the keyboard over the output
  // before anyone asked for it (#1375). A mouse-only window of that width has no soft keyboard to raise (#287).
  const takesKeyboard = !narrow || mouseOnly;
  const taking = useRef(takesKeyboard);
  taking.current = takesKeyboard;
  const catcher = useRef<HTMLTextAreaElement | null>(null);
  const held = useRef(new Map<number, HeldInput[]>());
  const before = useRef(new Map<number, Element | null>());
  const waits = useRef(new Map<number, () => void>());
  const next = useRef(0);
  const newest = useRef<number | null>(null);
  const report = useRef(dropped);
  report.current = dropped;

  useEffect(() => {
    const input = catcher.current;
    if (input === null) return undefined;
    const into = (each: HeldInput): void => {
      if (newest.current !== null) held.current.get(newest.current)?.push(each);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      // A key the app already took (a second New tab, the palette) is not the terminal's.
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || MODIFIERS.has(event.key)) return;
      event.preventDefault();
      into({ kind: "key", init: keyInit(event) });
    };
    const onCompositionEnd = (event: CompositionEvent): void => {
      if (event.data !== "") into({ kind: "text", data: event.data });
      input.value = "";
    };
    const onPaste = (event: ClipboardEvent): void => {
      const text = event.clipboardData?.getData("text") ?? "";
      event.preventDefault();
      if (text !== "") into({ kind: "paste", text });
    };
    input.addEventListener("keydown", onKeyDown);
    input.addEventListener("compositionend", onCompositionEnd);
    input.addEventListener("paste", onPaste);
    const pending = waits.current;
    return () => {
      input.removeEventListener("keydown", onKeyDown);
      input.removeEventListener("compositionend", onCompositionEnd);
      input.removeEventListener("paste", onPaste);
      for (const stop of pending.values()) stop();
      pending.clear();
    };
  }, []);

  const hold = useCallback((): number => {
    next.current += 1;
    const id = next.current;
    held.current.set(id, []);
    before.current.set(id, document.activeElement);
    newest.current = id;
    if (taking.current) {
      awake(catcher.current, true);
      catcher.current?.focus({ preventScroll: true });
    }
    return id;
  }, []);

  const finish = useCallback((id: number): HeldInput[] => {
    const queue = held.current.get(id) ?? [];
    held.current.delete(id);
    before.current.delete(id);
    waits.current.get(id)?.();
    waits.current.delete(id);
    if (newest.current === id) {
      newest.current = null;
      awake(catcher.current, false);
    }
    return queue;
  }, []);

  const giveUp = useCallback(
    (id: number, reason: DropReason): void => {
      const was = before.current.get(id) ?? null;
      const focusHere = newest.current === id && document.activeElement === catcher.current;
      const queue = finish(id);
      if (focusHere && was instanceof HTMLElement && was.isConnected) was.focus({ preventScroll: true });
      if (queue.length > 0) report.current(reason);
    },
    [finish],
  );

  const release = useCallback((id: number): void => giveUp(id, "failed"), [giveUp]);

  const deliver = useCallback(
    (id: number, address: string): void => {
      const hand = (input: HTMLTextAreaElement): void => {
        // Read before finish, which puts the hold out of the page: a person who moved on keeps the keyboard there.
        const last = taking.current && newest.current === id && keyboardStayed(catcher.current, address);
        const queue = finish(id);
        if (last) input.focus({ preventScroll: true });
        replay(input, queue);
      };
      const now = terminalInput(document, address);
      if (now !== null) return hand(now);
      // The view mounts once the feed lists the terminal; keys typed meanwhile still land in the hold.
      const watch = new MutationObserver(() => {
        const input = terminalInput(document, address);
        if (input !== null) hand(input);
      });
      const timer = setTimeout(() => giveUp(id, "slow"), MOUNT_BUDGET_MS);
      waits.current.set(id, () => {
        watch.disconnect();
        clearTimeout(timer);
      });
      watch.observe(document.body, { childList: true, subtree: true });
    },
    [finish, giveUp],
  );

  const holds = useCallback(
    (id: number, address: string): boolean => newest.current === id && keyboardStayed(catcher.current, address),
    [],
  );

  return useMemo(() => ({ hold, deliver, release, holds, catcher }), [hold, deliver, release, holds]);
}
