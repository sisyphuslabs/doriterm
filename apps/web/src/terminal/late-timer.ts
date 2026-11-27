import { SYNCHRONIZED_HOLD_CAP_MS } from "./held-update.ts";

/**
 * A pacer timer that runs later than this was held up by a page busy with other work, longer than any delay a page doing
 * nothing else adds to a timer (clamping, frame alignment). The output that arrived meanwhile is queued behind it, unseen,
 * so its window starts again rather than being read as quiet (#2895).
 */
export const LATE_TIMER_MS = 50;

/** What a late-proof timer reads: the page's clock, its timers, and when output last arrived. */
export interface LateTimerDeps {
  readonly clock: () => number;
  readonly timer: (run: () => void, ms: number) => () => void;
  readonly lastBytes: () => number;
}

/**
 * Runs `then` `ms` from now, or `again` when the timer runs more than {@link LATE_TIMER_MS} late: a page that ran
 * nothing else for that long (busy writing a batch, a starved tab, a phone waking) did not see the output that came
 * meanwhile, which is queued behind this timer, so its silence says nothing about whether the output stopped coming
 * (#2895). Returns its cancel.
 */
export function onTime(deps: LateTimerDeps, ms: number, then: () => void, again: () => void): () => void {
  const due = deps.clock() + ms;
  return deps.timer(() => {
    const now = deps.clock();
    // However late each timer runs, a page that has had no bytes for the hold's cap reads the window as it is.
    const late = now - due > LATE_TIMER_MS && now - deps.lastBytes() < SYNCHRONIZED_HOLD_CAP_MS;
    if (late) again();
    else then();
  }, ms);
}
