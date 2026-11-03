import type { Clock } from "./clock.ts";
import type { Gossip } from "./gossip.ts";

/** Section 6.5: `mesh leave` waits this long for an ack of its self-revoke before deleting the mesh state. */
export const LEAVE_ACK_WAIT_MS = 10_000;

export interface LeaveDeps {
  readonly gossip: Gossip;
  readonly self: string;
  readonly clock: Clock;
  readonly removeState: () => void;
  readonly waitMs?: number;
}

/**
 * `mesh leave` signs a self-revoke and pushes it before deleting anything, so the other members learn of the leave
 * instead of keeping a member that silently vanished. It deletes the state once one member acked, or after the wait.
 */
export async function leaveMesh(deps: LeaveDeps): Promise<"acked" | "timed out"> {
  const acked = deps.gossip.acked().then(() => "acked" as const);
  deps.gossip.append((prev) => ({ type: "revoke", prev, signPubs: [deps.self], reason: "leave" }));
  const { promise: timedOut, resolve } = Promise.withResolvers<"timed out">();
  const cancel = deps.clock.after(deps.waitMs ?? LEAVE_ACK_WAIT_MS, () => resolve("timed out"));
  const outcome = await Promise.race([acked, timedOut]);
  cancel();
  deps.removeState();
  return outcome;
}
