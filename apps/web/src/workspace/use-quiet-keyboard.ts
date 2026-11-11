import { type RefObject, useEffect, useRef } from "react";
import type { TerminalPort } from "../terminal/terminal-port.ts";

/**
 * The keyboard is down again (closed by its own key, by the keys' Hide, or by the focus moving away), so the terminal's
 * field asks for none until the keys ask again, and the next press in the terminal raises nothing (#1375).
 *
 * A press in the terminal lets the field go as it lands and takes it back as it lifts (use-focus-after-select.ts): one
 * gesture, not a dismissal. So the field keeps its mode until a press begun in `scope` ends, then a frame more for the
 * focus to come back. A frame counted from the press's start quieted it under a slow press, whose lift then raised no
 * keyboard (#2035). The press is that one pointer's: another one lifting meanwhile (a second finger, a tap beside a held
 * trackpad button) does not end it (#2093).
 */
export function useQuietKeyboard(port: RefObject<TerminalPort | null>, scope: HTMLElement | null, up: boolean): void {
  /** The pointer of the press begun in `scope` that is still down, or null. */
  const pressing = useRef<number | null>(null);
  useEffect(() => {
    if (scope === null) return undefined;
    const abort = new AbortController();
    const end = (event: PointerEvent): void => {
      if (event.pointerId === pressing.current) pressing.current = null;
    };
    scope.addEventListener(
      "pointerdown",
      (event) => {
        if (event.isPrimary) pressing.current = event.pointerId;
      },
      { capture: true, signal: abort.signal },
    );
    window.addEventListener("pointerup", end, { capture: true, signal: abort.signal });
    window.addEventListener("pointercancel", end, { capture: true, signal: abort.signal });
    return () => abort.abort();
  }, [scope]);
  useEffect(() => {
    if (up) return undefined;
    const abort = new AbortController();
    let frame = 0;
    const quietSoon = (): void => {
      frame = requestAnimationFrame(() => port.current?.quiet());
    };
    const held = pressing.current;
    if (held === null) quietSoon();
    else {
      const ended = (event: PointerEvent): void => {
        if (event.pointerId !== held) return;
        abort.abort();
        quietSoon();
      };
      window.addEventListener("pointerup", ended, { signal: abort.signal });
      window.addEventListener("pointercancel", ended, { signal: abort.signal });
    }
    return () => {
      abort.abort();
      cancelAnimationFrame(frame);
    };
  }, [up, port]);
}
