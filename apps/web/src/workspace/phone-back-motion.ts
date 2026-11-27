import { type MotionTiming, pictureToLeave, reducedMotion } from "./leave-motion.ts";

/** DESIGN.md 6: Back slides the leaving screen off over --duration-back on --ease-exit (motion-tokens.test.ts). */
export const BACK_MOTION: MotionTiming = { duration: 200, easing: "cubic-bezier(0.3, 0, 0.8, 0.15)" };

const moves = (): boolean => matchMedia("(pointer: coarse)").matches && !reducedMotion();

/**
 * Goes back at once, as before (the history pops in this same call, so a double tap still pops once, #2229, and the
 * screen underneath restores its scroll on its first frame, #1553), and slides a still copy of the screen that was left
 * off to the trailing edge over it. `from` is any element inside the leaving screen; its `.motion-arrive` root is the
 * screen. Without touch, or under reduced motion, Back is only the pop.
 */
export function backWithMotion(from: Element | null, go: () => void): void {
  const screen = from?.closest(".motion-arrive");
  if (!(screen instanceof HTMLElement) || !moves()) return go();
  const leave = pictureToLeave(screen, {
    keyframes: [{ transform: "translateX(0)" }, { transform: "translateX(100%)" }],
    timing: BACK_MOTION,
  });
  go();
  leave();
}
