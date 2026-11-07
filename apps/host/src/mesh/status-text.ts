import {
  type MeshMemberStatus,
  type MeshStatus,
  type MeshStuckReason,
  meshRevokeCommand,
  replacedMachineText,
} from "@doriface/protocol";

function stuckLine(reason: MeshStuckReason, nameOf: (hostId: string) => string): string {
  switch (reason.kind) {
    case "name_taken":
      return `name_taken: "${reason.name}" and its fallbacks are used on this core (${nameOf(reason.member)})`;
    case "invalid_name":
      return `invalid_name: herdr refused "${reason.name}": ${reason.message}`;
    case "copied_core":
      return `copied core: another mesh machine here answers with ${nameOf(reason.member)}'s core`;
    case "line_idle":
      return `the line to ${nameOf(reason.member)} has been up for 60 s without connecting`;
    case "possibly_revoked":
      return "possibly revoked";
    case "read_only":
      return `revoked by ${reason.by.map(nameOf).join(", ") || "another member"} (${reason.at ?? "time unknown"}); read-only until ${reason.until}`;
    case "removed_undecidable":
      return "removed by an undecidable revoke";
    case "log_full":
      return `mesh log full (${reason.records})`;
    case "counter_behind":
      return `counter behind its records (file ${reason.file}, mesh ${reason.mesh}): syncing before signing`;
  }
}

function memberLine(member: MeshMemberStatus, nameOf: (hostId: string) => string): string {
  const parts = [
    member.line === "self"
      ? "this host"
      : member.lineReason === null
        ? member.line
        : `${member.line}: ${member.lineReason}`,
  ];
  if (member.admittedBy !== null) parts.push(`admitted by ${nameOf(member.admittedBy)}`);
  else if (!member.overCap) parts.push("founder");
  if (member.overCap) parts.push("over an older host's member cap");
  if (member.presence) parts.push("present");
  if (member.lastSync !== null) parts.push(`last sync ${member.lastSync}`);
  if (member.owed > 0) parts.push(`${member.owed} records owed`);
  if (member.gate !== null)
    parts.push(`offline 4404 x${member.gate.refusals}, next probe at ${member.gate.nextProbeAt}`);
  if (member.helloCoreId !== null) parts.push(`line hello from core ${member.helloCoreId}`);
  const title = [member.name, member.hostId, member.fingerprint].filter((part) => part !== null).join(" ");
  const lines = [`  ${title}`, `    ${parts.join(", ")}`];
  if (member.replacedMachine !== null) {
    lines.push(`    ${replacedMachineText(member.replacedMachine)}`);
  }
  if (member.witnessPool.length === 0 && member.line !== "self") {
    const ask = member.witnessAsk === null ? "re-found if its key is compromised" : `ask ${nameOf(member.witnessAsk)}`;
    lines.push(`    revoke of ${member.name ?? member.hostId} would be undecidable from here; ${ask}`);
  }
  const revoke = member.revokeSuggested && member.name !== null ? meshRevokeCommand(member.name) : undefined;
  if (revoke !== undefined) lines.push(`    unreachable since ${member.unreachableSince}; to remove it: ${revoke}`);
  return lines.join("\n");
}

export function formatMeshStatus(status: MeshStatus): string {
  const names = new Map(status.members.map((member) => [member.hostId, member.name ?? member.hostId]));
  for (const revoked of status.revoked) names.set(revoked.hostId, revoked.name);
  const nameOf = (hostId: string): string => names.get(hostId) ?? hostId;
  const out = [`mesh ${status.meshId}, ${status.members.length} members`];
  out.push(status.sync === "ok" ? "sync: ok" : "sync: STUCK");
  for (const reason of status.stuck) out.push(`  STUCK: ${stuckLine(reason, nameOf)}`);
  if (status.budget.waiting > 0) out.push(`waiting for dial budget: ${status.budget.waiting} dials`);
  if (status.budget.halvedUntil !== null) out.push(`relay rate limit until ${status.budget.halvedUntil}`);
  out.push("members:", ...status.members.map((member) => memberLine(member, nameOf)));
  for (const join of status.pending) {
    out.push(`pending join: "${join.name}" ${join.hostId} fingerprint ${join.fingerprint}, until ${join.expiresAt}`);
  }
  for (const notice of status.notices) {
    out.push(
      `new member: ${notice.name} joined via ${nameOf(notice.admittedBy)}, admitted by ${nameOf(notice.admittedBy)}, ` +
        `fingerprint ${notice.fingerprint}, ${notice.seenAt}`,
    );
  }
  for (const revoked of status.revoked) {
    const by = revoked.revokedBy.map(nameOf).join(", ");
    out.push(`revoked: ${revoked.name} ${revoked.hostId} by ${by} (${revoked.reason})`);
  }
  for (const removed of status.removed) {
    const who = removed.members.map((entry) => entry.name).join(", ");
    out.push(
      `${who} removed by an undecidable backdated revoke of ${removed.revokedKey.name}; re-found or rotate keys`,
    );
  }
  return `${out.join("\n")}\n`;
}
