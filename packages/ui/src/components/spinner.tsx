import { useLayoutEffect, useRef } from "react";
import { cn } from "../lib/cn.ts";
import { useDelayedTrue } from "../lib/spinner-delay.ts";

export interface SpinnerProps {
  readonly className?: string;
  /** Accessible label; omit when a visible label sits next to it. */
  readonly label?: string;
}

/**
 * Starts every spinner's turn (or reduced-motion pulse) at the document timeline's zero, so all the spinners on a page
 * stand at the same angle at the same moment however late each one mounted (#1565). An animation already there is left
 * alone, so a re-render writes nothing (#1555). A paused turn is left as it stands: setting its start time would set it
 * going again (the landing's motion toggle pauses the mockups' spinners, #1179).
 */
export function inStep(element: Pick<Element, "getAnimations"> | null): void {
  if (element === null || typeof element.getAnimations !== "function") return;
  for (const animation of element.getAnimations()) {
    if (animation.playState !== "paused" && animation.startTime !== 0) animation.startTime = 0;
  }
}

/**
 * herdr-app's working glyph: one turn per 900 ms, or a gentle opacity pulse under reduced motion, in step with the
 * others. The box that turns is an HTML one around the glyph: on a display whose scale is not 1 (every Retina display)
 * Chromium does not hand a transform animated on an svg element to its compositor, so a spinner that turned its own
 * svg had the page recalculate style and rebuild its layer tree on every frame, for every spinner on screen, for as
 * long as an agent worked (#2607). An HTML box's turn runs on the compositor at the display's frame rate, and the page
 * does no work for it.
 */
export function Spinner({ className, label }: SpinnerProps) {
  const turn = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => inStep(turn.current));
  return (
    <span
      ref={turn}
      // CSS can replace the animation with no render, as when reduced motion is switched on while it turns (#1555).
      onAnimationStart={(event) => inStep(event.currentTarget)}
      data-slot="spinner-turn"
      className={cn("block size-3 shrink-0 animate-spin-status", className)}
    >
      <svg
        // Containers that size their icons leave the spinner's glyph alone by this mark (spinner-size.test.ts).
        data-slot="spinner"
        viewBox="0 0 16 16"
        fill="none"
        role={label === undefined ? undefined : "img"}
        aria-label={label}
        aria-hidden={label === undefined ? true : undefined}
        className="block size-full"
      >
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
        <path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </span>
  );
}

/**
 * A spinner for a wait that may still be quick: it stays hidden until {@link SPINNER_DELAY_MS} passes, and its box is
 * kept while it waits, so its arrival moves nothing around it.
 */
export function DelayedSpinner({ className }: { readonly className?: string }) {
  const shown = useDelayedTrue(true);
  return (
    <span aria-hidden="true" className={cn("inline-flex size-3 shrink-0 items-center justify-center", className)}>
      {shown ? <Spinner /> : null}
    </span>
  );
}
