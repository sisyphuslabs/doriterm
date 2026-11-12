import { type RefObject, useEffect, useRef } from "react";
import type { TerminalPort } from "../terminal/terminal-port.ts";

/** A pointer event as the tracker reads it. */
type PressEvent = Pick<PointerEvent, "pointerId" | "pointerType" | "isPrimary" | "buttons">;
const isPress = (event: Event): event is Event & PressEvent => "pointerId" in event && "isPrimary" in event;

/**
 * Follows the press begun in `scope` that is still down, until `signal` aborts: returns that press's pointer, or null.
 * The first press stays held until its own lift: a pointer of another type is primary for its own type, so a touch landing
 * beside a held mouse button does not take the press over (#2138). A new press of the same type does, since that type's
 * last press has ended even if the page never saw it lift. A lift can be lost across types too (the button let go over
 * another app, a context menu): the press also ends once its own pointer moves with no button down, or the page loses the
 * focus, so it can never be left held for good (#2160).
 */
export function trackHeldPress(scope: EventTarget, view: EventTarget, signal: AbortSignal): () => number | null {
  let held: { readonly pointer: number; readonly type: string } | null = null;
  const end = (event: Event): void => {
    if (isPress(event) && event.pointerId === held?.pointer) held = null;
  };
  scope.addEventListener(
    "pointerdown",
    (event) => {
      if (!isPress(event) || !event.isPrimary) return;
      if (held === null || held.type === event.pointerType)
        held = { pointer: event.pointerId, type: event.pointerType };
    },
    { capture: true, signal },
  );
  view.addEventListener("pointerup", end, { capture: true, signal });
  view.addEventListener("pointercancel", end, { capture: true, signal });
  view.addEventListener(
    "pointermove",
    (event) => {
      if (isPress(event) && event.buttons === 0) end(event);
    },
    { capture: true, signal },
  );
  // The page itself losing the focus, not a field in it: a press lets the terminal's field go as it lands (#2035), and
  // that blur reaches a capture listener here too.
  view.addEventListener(
    "blur",
    (event) => {
      if (event.target === view) held = null;
    },
    { capture: true, signal },
  );
  return () => held?.pointer ?? null;
}

/**
 * Calls `then` once no press is held, at once if none is, unless `signal` aborts first. It asks `held` again on every
 * event that can end a press rather than waiting for the pointer it saw first: a press whose lift was lost is replaced, and
 * the wait follows the press held now (#2160). The tracker's own listeners run first (capture), so `held` is current.
 */
export function whenPressEnds(
  view: EventTarget,
  held: () => number | null,
  then: () => void,
  signal: AbortSignal,
): void {
  if (held() === null) {
    then();
    return;
  }
  const done = new AbortController();
  const check = (): void => {
    if (held() !== null) return;
    done.abort();
    then();
  };
  // Not AbortSignal.any: Firefox before 124 lacks it, and the baseline is Firefox 121 (baseline.ts).
  signal.addEventListener("abort", () => done.abort(), { once: true, signal: done.signal });
  if (signal.aborted) return;
  const listen = { signal: done.signal };
  for (const type of ["pointerup", "pointercancel", "pointermove"]) view.addEventListener(type, check, listen);
  view.addEventListener("blur", (event) => event.target === view && check(), listen);
}

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
  const pressing = useRef<() => number | null>(() => null);
  useEffect(() => {
    if (scope === null) return undefined;
    const abort = new AbortController();
    pressing.current = trackHeldPress(scope, window, abort.signal);
    return () => {
      abort.abort();
      pressing.current = () => null;
    };
  }, [scope]);
  useEffect(() => {
    if (up) return undefined;
    const abort = new AbortController();
    let frame = 0;
    whenPressEnds(
      window,
      () => pressing.current(),
      () => {
        frame = requestAnimationFrame(() => port.current?.quiet());
      },
      abort.signal,
    );
    return () => {
      abort.abort();
      cancelAnimationFrame(frame);
    };
  }, [up, port]);
}
