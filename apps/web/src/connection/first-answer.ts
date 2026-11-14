import type { MemberConnection } from "./mesh-connections.ts";

/**
 * The member a start goes through (#2531): the first one that answers. The saved host is only where pairing left this
 * app, not a choice of route, so while it is still dialing and has not been reached this session, a member that is
 * already open carries the workspace. Never while the address names a place on the shown machine, which no other
 * machine has (#2532); and once a member has been reached, which one carries the traffic stays put for the session.
 */
export function firstAnswer(
  stores: ReadonlyMap<string, MemberConnection>,
  shown: MemberConnection,
  reached: (hostId: string) => boolean,
  holdsPlace: boolean,
): string | undefined {
  if (holdsPlace || shown.state.phase !== "connecting") return undefined;
  const id = [...stores.entries()].find(([, store]) => store === shown)?.[0];
  if (id === undefined || reached(id)) return undefined;
  return [...stores.entries()].find(([other, store]) => other !== id && store.state.phase === "open")?.[0];
}
