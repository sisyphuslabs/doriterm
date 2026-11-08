import type { MeshMemberStatus } from "@doriface/protocol";
import { type Reach, reachOf } from "./reach.ts";

/** This client's own session to one member: what it holds, not what the paired host says it holds. */
export type ClientSession = "connected" | "closed" | "unknown";

/**
 * What this client can reach, taking its own session to the member as the truth (#942).
 *
 * The paired host's document says what that host is exchanging with; a client paired with several machines holds its own
 * session to each, so a member it has closed is unreachable to the person even while the host still reports presence, and
 * a member it holds open is reachable even when the host's snapshot has not caught up. "unknown" is a member the client
 * has no session concept for yet, which falls back to the host's report.
 */
export function memberReach(member: Pick<MeshMemberStatus, "line" | "presence">, own: ClientSession): Reach {
  if (member.line === "self") return "this-host";
  if (own === "connected") return "open-session";
  if (own === "closed") return "no-session";
  return reachOf(member);
}
