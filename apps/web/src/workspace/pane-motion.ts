import { useLayoutEffect, useRef, type RefObject } from "react";
import type { Direction } from "../layout/neighbor.ts";
import type { Rect } from "../layout/rects.ts";
import type { Bump } from "./use-pane-moves.ts";

/** DESIGN.md section 6: a pane moves at Standard (220 ms) and a nudge at Micro (120 ms), both on `--ease-out`. */
const DURATION = 220;
const NUDGE_DURATION = 120;
const EASE = "cubic-bezier(0.23, 1, 0.32, 1)";
const NUDGE: Readonly<Record<Direction, string>> = {
  left: "translateX(-4px)",
  right: "translateX(4px)",
  up: "translateY(-4px)",
  down: "translateY(4px)",
};

const reduced = (): boolean => matchMedia("(prefers-reduced-motion: reduce)").matches;

export interface PaneMotion {
  readonly rect: Rect;
  /** The box all panes are laid out in: when it changes (a window resize) panes take their place without motion. */
  readonly frame: string;
  /** How the pane arrived: grown out of the pane it split (`row`: from the left edge, `column`: from the top), or null. */
  readonly grow: "row" | "column" | null;
  readonly bump: Bump | null;
}

/** The pane's own box clipped to `width` x `height` from its top left, as `clip-path` keyframes take it. */
const clipTo = (rect: Rect, width: number, height: number): string =>
  `inset(0px ${Math.max(0, rect.width - width)}px ${Math.max(0, rect.height - height)}px 0px round 8px)`;
const UNCLIPPED = "inset(0px 0px 0px 0px round 8px)";

/**
 * Moves a pane to its new rectangle (FLIP) with `translate` for its place and `clip-path` for its size: the box takes
 * its final size at once and the drawing slides and opens from where it was. No `scale`: the terminal measures its cell
 * with getBoundingClientRect, which a transform's scale would distort while its ResizeObserver reads the new size
 * (@wterm/dom 0.5.9 `_measureCharSize`), leaving every row drawn at the wrong cell width. A new pane opens from the edge
 * it was split from, and a key that cannot move focus nudges the focused pane toward that edge. A window resize moves
 * every pane at once, so it plays no motion.
 */
export function usePaneMotion(ref: RefObject<HTMLElement | null>, { rect, frame, grow, bump }: PaneMotion): void {
  const last = useRef<Rect | null>(null);
  const lastFrame = useRef(frame);
  const bumped = useRef(bump?.seq ?? 0);
  useLayoutEffect(() => {
    const element = ref.current;
    const before = last.current;
    const resized = lastFrame.current !== frame;
    last.current = rect;
    lastFrame.current = frame;
    if (element === null || rect.width === 0 || rect.height === 0 || resized) return;
    if (before === null) {
      if (grow === null) return;
      if (reduced()) {
        element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DURATION, easing: EASE });
        return;
      }
      const from = grow === "row" ? clipTo(rect, 0, rect.height) : clipTo(rect, rect.width, 0);
      element.animate(
        [
          { clipPath: from, opacity: 0.4 },
          { clipPath: UNCLIPPED, opacity: 1 },
        ],
        {
          duration: DURATION,
          easing: EASE,
        },
      );
      return;
    }
    if (reduced() || before.width === 0 || before.height === 0) return;
    const [dx, dy] = [before.x - rect.x, before.y - rect.y];
    const [dw, dh] = [before.width - rect.width, before.height - rect.height];
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(dw) < 0.5 && Math.abs(dh) < 0.5) return;
    element.animate(
      [
        { transform: `translate(${dx}px, ${dy}px)`, clipPath: clipTo(rect, before.width, before.height) },
        { transform: "none", clipPath: UNCLIPPED },
      ],
      { duration: DURATION, easing: EASE },
    );
  }, [ref, rect, frame, grow]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (bump === null || bump.seq === bumped.current || element === null) return;
    bumped.current = bump.seq;
    const keyframes = reduced()
      ? [{ opacity: 1 }, { opacity: 0.7 }, { opacity: 1 }]
      : [{ transform: "none" }, { transform: NUDGE[bump.direction] }, { transform: "none" }];
    element.animate(keyframes, { duration: NUDGE_DURATION, easing: EASE });
  }, [ref, bump]);
}
