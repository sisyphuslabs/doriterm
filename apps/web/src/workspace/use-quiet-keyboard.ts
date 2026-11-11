import { type RefObject, useEffect, useRef } from "react";
import type { TerminalPort } from "../terminal/terminal-port.ts";

/**
 * The keyboard is down again (closed by its own key, by the keys' Hide, or by the focus moving away), so the terminal's
 * field asks for none until the keys ask again, and the next press in the terminal raises nothing (#1375).
 *
 * A press in the terminal lets the field go as it lands and takes it back as it lifts (use-focus-after-select.ts): one
 * gesture, not a dismissal. So the field keeps its mode until a press begun in `scope` ends, then a frame more for the
 * focus to come back. A frame counted from the press's start quieted it under a slow press, whose lift then raised no
 * keyboard (#2035).
 */
export function useQuietKeyboard(port: RefObject<TerminalPort | null>, scope: HTMLElement | null, up: boolean): void {
  const pressing = useRef(false);
  useEffect(() => {
    if (scope === null) return undefined;
    const abort = new AbortController();
    const end = (): void => {
      pressing.current = false;
    };
    scope.addEventListener(
      "pointerdown",
      (event) => {
        if (event.isPrimary) pressing.current = true;
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
    if (!pressing.current) quietSoon();
    else {
      window.addEventListener("pointerup", quietSoon, { once: true, signal: abort.signal });
      window.addEventListener("pointercancel", quietSoon, { once: true, signal: abort.signal });
    }
    return () => {
      abort.abort();
      cancelAnimationFrame(frame);
    };
  }, [up, port]);
}
