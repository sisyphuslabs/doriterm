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
 * stand at the same angle at the same moment however late each one mounted (#1565). A paused turn is left as it stands:
 * setting its start time would set it going again (the landing's motion toggle pauses the mockups' spinners, #1179).
 */
function inStep(element: SVGSVGElement | null): void {
  if (element === null || typeof element.getAnimations !== "function") return;
  for (const animation of element.getAnimations()) if (animation.playState !== "paused") animation.startTime = 0;
}

/** herdr-app's working glyph: one turn per 900 ms, or a gentle opacity pulse under reduced motion, in step with the others. */
export function Spinner({ className, label }: SpinnerProps) {
  const glyph = useRef<SVGSVGElement>(null);
  useLayoutEffect(() => inStep(glyph.current));
  return (
    <svg
      ref={glyph}
      data-slot="spinner"
      viewBox="0 0 16 16"
      fill="none"
      role={label === undefined ? undefined : "img"}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
      className={cn("size-3 shrink-0 animate-spin-status", className)}
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
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
