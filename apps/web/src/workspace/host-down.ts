import { useEffect, useState } from "react";
import { hostFailure } from "../connection/host-failure.ts";
import { staysOnThisComputer } from "../connection/settings.ts";
import { type ConnectionState, connectionStore, useConnection } from "../connection/store.ts";
import { useOnline } from "../pwa/use-online.ts";

/** How long the host's link may be down before the page says why and offers to try now: the host's own grace (#2448). */
export const HOST_DOWN_GRACE_MS = 5_000;

/** Whether the workspace on screen is still shown while its host's link is down: the drop the grace is counted from. */
export const linkDown = (state: ConnectionState): boolean =>
  ((state.phase === "failed" || state.phase === "connecting") && state.stale !== null) ||
  (state.phase === "open" && state.resuming === true);

/**
 * Why the host cannot be reached, in the words Settings uses (#2426), once its link has been down for the grace (#2464):
 * a routine redial says only that it reconnects, and one that lasts says why, beside one way to try now. Null within the
 * grace, while nothing has failed yet, and once the link is back.
 */
export function hostDownWhy(state: ConnectionState, downFor: number | null): string | null {
  if (downFor === null || downFor < HOST_DOWN_GRACE_MS) return null;
  if (state.phase === "failed" && state.stale !== null)
    return state.settling === true ? state.error.message : hostFailure(state.error);
  if (state.phase === "open" && state.resuming === true && state.resumeFailure !== undefined)
    return hostFailure(state.resumeFailure);
  return null;
}

/** hostDownWhy for the workspace's connection as it is now; null while the network itself is what is missing. */
export function useHostDownWhy(): string | null {
  const state = useConnection();
  const online = useOnline();
  const down = linkDown(state);
  const [since, setSince] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!down) return setSince(null);
    const start = Date.now();
    setSince(start);
    setNow(start);
    const timer = setTimeout(() => setNow(Date.now()), HOST_DOWN_GRACE_MS);
    return () => clearTimeout(timer);
  }, [down]);
  if (!online && !staysOnThisComputer(connectionStore.settings)) return null;
  return hostDownWhy(state, since === null ? null : Math.max(0, now - since));
}
