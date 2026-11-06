/**
 * A test hook: e2e sets `window.__dorifaceDirectBudgetMs` before the page loads, and the direct race runs on that budget
 * instead of the contract's 300 ms. `Infinity` leaves the race to the direct attempt's own answer or failure, so a spec
 * about which path carries the session is decided by the spec, not by how fast the test machine answers (#780). Nothing
 * in the app sets it.
 */
export function directBudgetProbe(): number | undefined {
  const value: unknown = Reflect.get(globalThis, "__dorifaceDirectBudgetMs");
  return typeof value === "number" && value > 0 ? value : undefined;
}
