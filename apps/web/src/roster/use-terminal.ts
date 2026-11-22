import type { HcConnection } from "@doriface/client";
import type { Terminal } from "@doriface/protocol";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { rosterFor } from "./roster.ts";

const unwatched = (): (() => void) => () => undefined;

/**
 * One terminal as it stands now, its title and foreground included; it renders only when that terminal changes
 * (#2607). A reader that is not `watching` (a pane nobody can see) is told of nothing, so it renders for no change,
 * and reads the terminal as it stands the moment it watches again.
 */
export function useTerminal(connection: HcConnection, address: string, watching = true): Terminal | undefined {
  const roster = useMemo(() => rosterFor(connection), [connection]);
  const subscribe = useCallback(
    (listener: () => void) => (watching ? roster.live.subscribeTo(address, listener) : unwatched()),
    [roster, address, watching],
  );
  return useSyncExternalStore(subscribe, () => roster.live.get(address));
}
