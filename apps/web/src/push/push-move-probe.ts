/**
 * A test hook: e2e sets `window.__dorifacePushMoves` to an array before the page loads, and every notifications move
 * adds its promise to it, so a spec waits for the move its connection change started instead of polling the hosts on a
 * clock (#780). Nothing in the app sets it.
 */
export function recordPushMove(moved: Promise<void>): void {
  const moves: unknown = Reflect.get(globalThis, "__dorifacePushMoves");
  if (Array.isArray(moves)) moves.push(moved);
}
