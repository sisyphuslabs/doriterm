export interface EndHolder {
  readonly stop: () => void;
}

/** A scroller's view of its content: the hold is what moves `scrollTop`. */
interface Scroller {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

const maxScrollTop = (scroller: Scroller): number => scroller.scrollHeight - scroller.clientHeight;

const isAtEnd = (scroller: Scroller): boolean => maxScrollTop(scroller) - scroller.scrollTop <= 1;

/**
 * Holds a scroller at its end while a reattach replay arrives (#1040). Only a reader who was at the end is held, and the
 * hold lets go if they scroll away, so it never pulls someone out of history they were reading.
 */
export function holdAtEnd(scroller: Scroller, streaming: () => boolean): EndHolder {
  if (!isAtEnd(scroller)) return { stop: () => undefined };
  let stopped = false;
  // Where the hold last left the scroller; null until it has moved it. The reset renders before the hold's first frame
  // and empties the scroller, so a position the hold never wrote is not a reader scrolling away.
  let wrote: number | null = null;
  const frame = (): void => {
    if (stopped) return;
    // With no history there is nowhere to have scrolled away to: the reset's collapse reads as this, and the hold goes
    // on from it. Only a position the hold wrote, and the reader then moved while history is above, lets go.
    const canScrollAway = maxScrollTop(scroller) > 1;
    if (wrote !== null && canScrollAway && !isAtEnd(scroller) && Math.abs(scroller.scrollTop - wrote) > 1) return;
    scroller.scrollTop = scroller.scrollHeight;
    // What the element accepted, not what was written: a real scroller clamps to its content.
    wrote = scroller.scrollTop;
    if (!streaming()) return;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  return {
    stop: () => {
      stopped = true;
    },
  };
}
