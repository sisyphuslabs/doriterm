import type { MeshMemberStatus } from "@doriface/protocol";

/**
 * Whether this host is exchanging with a member right now, and whether the member is this host. It deliberately says
 * nothing about the route: the host dials every member stream, the herdr `hc` line included, through its own relay
 * (`apps/host/src/mesh/host-sync.ts` `#dialOnce`), and a LAN session counts as presence too, so "direct" and "relayed"
 * cannot be told apart from here and a row must not guess (review of #772).
 */
export type Reach = "this-host" | "open-session" | "no-session";

/** Presence is the only proof something is reached now; a line herdr holds without a session proves nothing (#754). */
export function reachOf(member: Pick<MeshMemberStatus, "line" | "presence">): Reach {
  if (member.line === "self") return "this-host";
  return member.presence ? "open-session" : "no-session";
}

export const REACH_LABEL: Readonly<Record<Reach, string>> = {
  "this-host": "this host",
  "open-session": "session open now",
  "no-session": "no session now",
};
