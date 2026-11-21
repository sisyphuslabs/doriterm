import type { MemberConnection } from "./mesh-connections.ts";
import type { ConnectionSettings } from "./settings.ts";

/**
 * The open member a shown machine that is down gives way to, if any. None unless the shown one failed (one not dialled
 * yet, such as a machine an edit just chose, is not down), when it is `kept` (reached in this page, so its drop never
 * moves the person, #2464, or the person picked it, #2532), or while the address names a place on it and a retry can
 * still bring it back: a space or a terminal open there is on no other machine.
 */
export function failOverTo(
  stores: ReadonlyMap<string, MemberConnection>,
  shown: MemberConnection,
  kept: (hostId: string) => boolean,
  holdsPlace: boolean,
): string | undefined {
  const state = shown.state;
  if (state.phase !== "failed" && state.phase !== "host-failed") return undefined;
  const id = [...stores.entries()].find(([, store]) => store === shown)?.[0];
  if (id !== undefined && kept(id)) return undefined;
  if (holdsPlace && state.phase === "failed" && state.retryInMs !== null) return undefined;
  return [...stores.entries()].find(([, store]) => store.state.phase === "open")?.[0];
}

/**
 * Settings a caller built from what is shown (`MeshConnections.settings`, e.g. Start this computer), with the machine put back
 * to the saved one when they name the machine a failover only shows: that one is not the person's choice, so it is never
 * saved (#2535 review L6).
 */
export function withoutShownMachine(
  settings: ConnectionSettings,
  saved: ConnectionSettings,
  shown: string | undefined,
): ConnectionSettings {
  if (shown === undefined || settings.hostId !== shown) return settings;
  const { hostId, hostName, hostKey, directUrl } = saved;
  return { ...settings, hostId, hostName, hostKey, directUrl };
}

/** Whether the page's address names a place on the shown machine: a phone's space screen or open terminal (`?s=`, `?t=`). */
export function placeInAddress(search: string = globalThis.location?.search ?? ""): boolean {
  const params = new URLSearchParams(search);
  return params.has("s") || params.has("t");
}
