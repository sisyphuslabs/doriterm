import { browserStorage } from "../storage/guarded.ts";

const COUNTERS = [
  "views",
  "attachAttempts",
  "errorsShown",
  "manualRetries",
  "manualImmediateSuccesses",
  "automaticRecoveries",
  "interactionRecoveries",
] as const;
type Counter = (typeof COUNTERS)[number];
const KEY = "doriterm.terminal-recovery.v1";

/**
 * Anonymous counts for this browser tab, retained across reloads. No terminal, machine, input or error text is stored
 * or transmitted. The event lets a diagnostics consumer observe the same measurement without polling storage.
 */
export function recordRecovery(counter: Counter): void {
  if (typeof window === "undefined") return;
  try {
    const storage = browserStorage("sessionStorage");
    const raw = storage.getItem(KEY);
    const saved: unknown = raw === null ? null : JSON.parse(raw);
    const previous = typeof saved === "object" && saved !== null ? saved : {};
    const counts: Record<string, number> = {};
    for (const name of COUNTERS) {
      const value: unknown = Reflect.get(previous, name);
      counts[name] = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
    }
    const since: unknown = Reflect.get(previous, "since");
    counts["since"] = typeof since === "number" && Number.isFinite(since) ? since : Date.now();
    counts[counter] = (counts[counter] ?? 0) + 1;
    storage.setItem(KEY, JSON.stringify(counts));
    dispatchEvent(new CustomEvent("doriterm:terminal-recovery", { detail: { counter, counts } }));
  } catch (error) {
    // Storage denial or a damaged diagnostics record must not prevent the terminal from reconnecting.
    if (!(error instanceof DOMException || error instanceof SyntaxError)) throw error;
  }
}
