/**
 * A test hook: e2e sets `window.__dorifacePushMoves` to an array before the page loads, and every notifications move
 * adds its promise to it, so a spec waits for the move its connection change started instead of polling the hosts on a
 * clock (#780). Nothing in the app sets it.
 */
export function recordPushMove(moved: Promise<void>): void {
  const moves: unknown = Reflect.get(globalThis, "__dorifacePushMoves");
  if (Array.isArray(moves)) moves.push(moved);
}

/**
 * The same hook for the reader's own actions (#2934): e2e sets `window.__dorifacePushSteps` to an array before the page
 * loads, and Turn on and Turn off add their whole action to it as they start, so a spec reads the state once the action
 * is done, not after a fixed wait a loaded host's round trips can outlast. Nothing in the app sets it.
 */
export function recordPushStep(step: Promise<void>): void {
  const steps: unknown = Reflect.get(globalThis, "__dorifacePushSteps");
  if (Array.isArray(steps)) steps.push(step);
}
