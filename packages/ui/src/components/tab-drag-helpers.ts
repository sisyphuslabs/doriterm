import { useCallback, useEffect, useRef } from "react";

/** Within this distance of an end of an overflowing strip the strip scrolls under the dragged tab. */
const EDGE_PX = 32;
const EDGE_STEP_PX = 8;

/** Cancels a touch's tap, so the browser sends no mouse events for it. */
export function cancelTap(touchEnd: TouchEvent): void {
  if (touchEnd.cancelable) touchEnd.preventDefault();
}

/** Horizontal scroll step (px/frame) when a dragged tab hovers near either end of `box`. */
export function edgeStep(clientX: number, box: DOMRect): number {
  if (clientX < box.left + EDGE_PX) return -EDGE_STEP_PX;
  if (clientX > box.right - EDGE_PX) return EDGE_STEP_PX;
  return 0;
}

export interface ClickLatch {
  /** Arms the latch until either the suppressed click arrives or the next press/key anywhere clears it. */
  readonly arm: () => void;
  /** Capture handler that swallows one click while armed. */
  readonly onClickCapture: (event: { stopPropagation(): void; preventDefault(): void }) => void;
}

/**
 * Swallows the click that ends a drag; a drop let go off the strip sends none, so the next press or key anywhere
 * clears the latch instead, and a later click or Enter on a tab still selects it.
 */
export function useClickLatch(): ClickLatch {
  const armed = useRef(false);
  const disarm = useRef<() => void>(() => undefined);

  const arm = useCallback(() => {
    disarm.current();
    armed.current = true;
    const clear = (): void => {
      armed.current = false;
      window.removeEventListener("pointerdown", clear, true);
      window.removeEventListener("keydown", clear, true);
      disarm.current = () => undefined;
    };
    window.addEventListener("pointerdown", clear, true);
    window.addEventListener("keydown", clear, true);
    disarm.current = clear;
  }, []);

  useEffect(() => () => disarm.current(), []);

  const onClickCapture = useCallback((event: { stopPropagation(): void; preventDefault(): void }) => {
    if (!armed.current) return;
    disarm.current();
    event.stopPropagation();
    event.preventDefault();
  }, []);

  return { arm, onClickCapture };
}
