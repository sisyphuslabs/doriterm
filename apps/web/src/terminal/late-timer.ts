/**
 * A pacer timer that runs later than this was held up by a page busy with other work, longer than any delay a page doing
 * nothing else adds to a timer (clamping, frame alignment). The output that arrived meanwhile is queued behind it, unseen,
 * so its reading waits for what was queued ({@link onTime}, #2895).
 */
export const LATE_TIMER_MS = 50;

/** What a late-proof timer reads: the page's clock, its timers, and when output last arrived. */
export interface LateTimerDeps {
  readonly clock: () => number;
  readonly timer: (run: () => void, ms: number) => () => void;
  readonly lastBytes: () => number;
}

/**
 * Runs `then` `ms` from now. A timer that runs more than {@link LATE_TIMER_MS} late ran on a page busy with other work
 * (writing a batch, a starved tab, a phone waking, a relayout on every step of a drag): output that came meanwhile is
 * queued behind it, unseen (#2895). So its reading waits one task, behind what was queued: `again` if bytes came by
 * then, else `then`. It waits for the bytes it suspects, not for another window: a busy page with nothing coming is
 * read as quiet at once, so a drag on a loaded machine cannot keep a hold for good (#2941). Returns its cancel.
 */
export function onTime(deps: LateTimerDeps, ms: number, then: () => void, again: () => void): () => void {
  const due = deps.clock() + ms;
  let cancelReading: (() => void) | undefined;
  const cancel = deps.timer(() => {
    if (deps.clock() - due <= LATE_TIMER_MS) {
      then();
      return;
    }
    const seen = deps.lastBytes();
    cancelReading = deps.timer(() => (deps.lastBytes() === seen ? then() : again()), 0);
  }, ms);
  return () => {
    cancel();
    cancelReading?.();
  };
}
