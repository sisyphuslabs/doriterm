import { type RefObject, useLayoutEffect, useRef } from "react";
import { type MotionTiming, reducedMotion } from "./leave-motion.ts";

/** DESIGN.md 6, Keyboard ride: --duration-card on --ease-standard (motion-tokens.test.ts). */
export const RIDE_MOTION: MotionTiming = { duration: 240, easing: "cubic-bezier(0.2, 0, 0, 1)" };

/** How far a running motion has the element translated down, in CSS px (0 at rest). */
const shiftOf = (element: HTMLElement): number => new DOMMatrixReadOnly(getComputedStyle(element).transform).m42;

/** Where the element's bottom edge is laid out in the page, without the part a running motion has moved it. */
const laidOutBottom = (element: HTMLElement): number =>
  element.getBoundingClientRect().bottom + window.scrollY - shiftOf(element);

/**
 * Moves the element in `ref` from where it stood to its new place by a translate (FLIP) each time `place` changes: the
 * keys panel docking under the terminal or riding on the soft keyboard, and following the keyboard's height. Its bottom
 * edge is what rides, in page coordinates, so a field that grows the panel upward (the input card) moves nothing, and a
 * move that starts mid-motion starts from where the panel is drawn. A window resize or rotation moves the panel without
 * motion, and the next ride starts from where that left it. Under reduced motion the panel takes its place at once.
 */
export function useRideMotion(ref: RefObject<HTMLElement | null>, place: string): void {
  const laidOut = useRef<number | null>(null);
  useLayoutEffect(() => {
    const follow = (): void => {
      if (ref.current !== null) laidOut.current = laidOutBottom(ref.current);
    };
    window.addEventListener("resize", follow);
    return () => window.removeEventListener("resize", follow);
  }, [ref]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) {
      laidOut.current = null;
      return;
    }
    const shift = shiftOf(element);
    const bottom = laidOutBottom(element);
    const before = laidOut.current;
    laidOut.current = bottom;
    if (before === null || reducedMotion()) return;
    const from = before + shift - bottom;
    if (Math.abs(from) < 0.5) return;
    for (const motion of element.getAnimations()) motion.cancel();
    element.animate([{ transform: `translateY(${from}px)` }, { transform: "none" }], RIDE_MOTION);
  }, [ref, place]);
}
