import type { HcConnection } from "@doriface/client";
import { useMemo, useSyncExternalStore } from "react";
import { type Roster, type RosterSnapshot, rosterFor } from "./roster.ts";

/** The shared roster of the core this connection reaches, and its snapshot as of this render. */
export function useRoster(connection: HcConnection): { readonly roster: Roster; readonly snapshot: RosterSnapshot } {
  const roster = useMemo(() => rosterFor(connection), [connection]);
  const snapshot = useSyncExternalStore(roster.subscribe, () => roster.snapshot);
  return { roster, snapshot };
}
