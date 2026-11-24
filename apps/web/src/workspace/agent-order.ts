/**
 * The order the Agents list draws its rows in, after its filter and folds: what Next agent and Previous agent step
 * through, so the keys follow what is on screen once rows nest under the agent that started them (#2746).
 */
let drawn: readonly string[] | null = null;

/** The Agents list says what it drew. Returns the call that takes it back when that list goes away. */
export function publishAgentOrder(order: readonly string[]): () => void {
  drawn = order;
  return () => {
    if (drawn === order) drawn = null;
  };
}

/**
 * The live agents in the order to step through them: as drawn, a row that has ended left out; the feed's own order
 * (`live` itself) before a list has drawn, or while it draws none of them.
 */
export function steppedAgents(live: readonly string[]): readonly string[] {
  if (drawn === null) return live;
  const alive = new Set(live);
  const shown = drawn.filter((address) => alive.has(address));
  return shown.length === 0 ? live : shown;
}
