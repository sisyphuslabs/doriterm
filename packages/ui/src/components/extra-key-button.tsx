import { type MouseEvent, useCallback, useEffect, useRef } from "react";
import { cn } from "../lib/cn.ts";
import type { ExtraKey } from "./extra-keys-bar.tsx";

/** A mousedown that would move focus off the terminal would also drop the soft keyboard. */
export function keepFocus(event: MouseEvent): void {
  event.preventDefault();
}

export const keyTarget =
  "relative flex h-11 min-w-11 shrink-0 items-center justify-center rounded-full px-1.5 outline-none [&_svg:not([data-slot=spinner])]:size-5 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring";
export const latchedKey =
  "bg-primary font-semibold text-primary-foreground after:absolute after:bottom-1.5 after:h-0.5 after:w-3 after:rounded-full after:bg-current active:opacity-80";
export const idleKey = "text-foreground active:bg-selected";

/** How long a key is held before the hold counts; a shorter press is the tap it always was. */
const HOLD_MS = 400;

const symbol = (entry: ExtraKey): boolean => typeof entry.label === "string" && entry.label.length === 1;

export interface KeyButtonProps {
  readonly entry: ExtraKey;
  readonly latched: boolean;
  readonly onKey: ((id: string) => void) | undefined;
  readonly onHold: ((id: string) => void) | undefined;
}

/**
 * One bar key. A held press is its own gesture where the caller names one (Ctrl opens the packs panel); the tap that
 * follows a hold sends nothing, so opening a panel never latches a modifier by accident.
 */
export function KeyButton({ entry, latched, onKey, onHold }: KeyButtonProps) {
  const timer = useRef<number | null>(null);
  const held = useRef(false);
  const stop = useCallback((): void => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => stop, [stop]);
  const start = (): void => {
    held.current = false;
    if (onHold === undefined) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      held.current = true;
      onHold(entry.id);
    }, HOLD_MS);
  };
  return (
    <button
      type="button"
      aria-label={entry.name}
      aria-pressed={entry.modifier === true ? latched : undefined}
      onMouseDown={keepFocus}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onContextMenu={onHold === undefined ? undefined : (event) => event.preventDefault()}
      onClick={() => {
        if (held.current) {
          held.current = false;
          return;
        }
        onKey?.(entry.id);
      }}
      className={cn(
        keyTarget,
        symbol(entry) ? "font-mono text-base" : "text-[0.8125rem] font-medium",
        latched ? latchedKey : idleKey,
      )}
    >
      {entry.label}
    </button>
  );
}
