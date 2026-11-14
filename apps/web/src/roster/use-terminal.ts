import type { HcConnection } from "@doriface/client";
import type { Terminal } from "@doriface/protocol";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { rosterFor } from "./roster.ts";

/** One terminal as it stands now, its title and foreground included; it renders only when that terminal changes (#2607). */
export function useTerminal(connection: HcConnection, address: string): Terminal | undefined {
  const roster = useMemo(() => rosterFor(connection), [connection]);
  const subscribe = useCallback(
    (listener: () => void) => roster.live.subscribeTo(address, listener),
    [roster, address],
  );
  return useSyncExternalStore(subscribe, () => roster.live.get(address));
}
