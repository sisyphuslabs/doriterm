import { parseRecord, type Signed } from "@doriface/mesh";
import type { MeshView } from "./mesh-view.ts";
import type { SyncSession } from "./sync.ts";

/** The keys the revokes among `records` name (section 5.3 pushes to them last). */
export function revokedBy(records: readonly Signed[]): ReadonlySet<string> {
  const revoked = new Set<string>();
  for (const record of records) {
    const body = parseRecord(record);
    const subject = body?.type === "revoke" ? body.subject : undefined;
    if (subject !== undefined && "signPubs" in subject) for (const key of subject.signPubs) revoked.add(key);
  }
  return revoked;
}

/**
 * Section 6.2: a revoked member's inbound sessions close at once through LiveSessions; one this host dialed, at the
 * view change or later (section 5.3's last push to it), retires within the linger; back in the view (re-admitted),
 * it stays.
 */
export function retireIfGone(session: SyncSession, view: MeshView, self: string): void {
  if (session.dialer !== self) return;
  if (view.members.some((member) => member.signPub === session.peer)) session.keep();
  else session.retire("revoked from the mesh");
}
