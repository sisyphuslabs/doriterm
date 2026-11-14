import type { MemberConnection } from "./mesh-connections.ts";

/**
 * The open member a shown machine that is down gives way to, if any. None while the shown one is open or connecting, once
 * this page has reached it (its drop never moves the person, #2464), or while the address names a place on it and a retry
 * can still bring it back: a space or a terminal open there is not on any other machine (#2532).
 */
export function failOverTo(
  stores: ReadonlyMap<string, MemberConnection>,
  shown: MemberConnection,
  reached: (hostId: string) => boolean,
  holdsPlace: boolean,
): string | undefined {
  const state = shown.state;
  if (state.phase === "open" || state.phase === "connecting") return undefined;
  const id = [...stores.entries()].find(([, store]) => store === shown)?.[0];
  if (id !== undefined && reached(id)) return undefined;
  if (holdsPlace && state.phase === "failed" && state.retryInMs !== null) return undefined;
  return [...stores.entries()].find(([, store]) => store.state.phase === "open")?.[0];
}

/** Whether the page's address names a place on the shown machine: a phone's space screen or open terminal (`?s=`, `?t=`). */
export function placeInAddress(search: string = globalThis.location?.search ?? ""): boolean {
  const params = new URLSearchParams(search);
  return params.has("s") || params.has("t");
}
