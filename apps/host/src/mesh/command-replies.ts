import { isRecord } from "../state/files.ts";

// What the running host answers on `host.sock` to `mesh-revoke`, `mesh-rename` and `mesh-leave` (section 10.1), and
// the parsers the CLI reads them with.

export interface MemberRef {
  readonly hostId: string;
  readonly name: string;
}

export interface RevokeReply {
  /** False when the revoke needs `--yes` (a `--compromised` batch or an empty witness pool) and did not get it. */
  readonly written: boolean;
  readonly target: MemberRef;
  readonly subjects: readonly MemberRef[];
  readonly clients: readonly MemberRef[];
  readonly reason: "revoke" | "compromised";
  /** The section 6.1 preview: the subtree, and the witness-pool warnings. */
  readonly lines: readonly string[];
  readonly needsYes: boolean;
}

export interface RenameReply {
  readonly written: boolean;
  /** The member, under the name it had before. */
  readonly member: MemberRef;
  readonly name: string;
}

export interface LeaveReply {
  /** False when this host's view no longer holds it as a member, so it had no revoke to sign. */
  readonly signed: boolean;
  readonly members: readonly MemberRef[];
  readonly confirmed: readonly MemberRef[];
  /** Set when other members exist and none confirmed: the revoke to run on one of them. */
  readonly revokeCommand: string | null;
  /** Why this host's mesh machines were not all removed from its core (design 6.5), or null once they were. */
  readonly machinesKept: string | null;
}

const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

function memberRef(value: unknown): MemberRef | undefined {
  if (!isRecord(value)) return undefined;
  const { hostId, name } = value;
  return isString(hostId) && isString(name) ? { hostId, name } : undefined;
}

function memberRefs(value: unknown): readonly MemberRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs = value.map(memberRef);
  return refs.every((ref) => ref !== undefined) ? refs.filter((ref) => ref !== undefined) : undefined;
}

function unreadable(): never {
  throw new Error("the running host answered with a reply this version cannot read");
}

export function parseRevokeReply(value: unknown): RevokeReply {
  if (!isRecord(value)) return unreadable();
  const { written, reason, lines, needsYes } = value;
  const target = memberRef(value["target"]);
  const subjects = memberRefs(value["subjects"]);
  const clients = value["clients"] === undefined ? [] : memberRefs(value["clients"]);
  if (!isBoolean(written) || !isBoolean(needsYes) || target === undefined || subjects === undefined) unreadable();
  if (reason !== "revoke" && reason !== "compromised") return unreadable();
  if (!Array.isArray(lines) || !lines.every(isString)) return unreadable();
  if (clients === undefined) return unreadable();
  return { written, target, subjects, clients, reason, lines, needsYes };
}

export function parseLeavePreview(value: unknown): { readonly clients: readonly MemberRef[] } {
  if (!isRecord(value)) return unreadable();
  const clients = memberRefs(value["clients"]);
  if (clients === undefined) return unreadable();
  return { clients };
}

export function parseRenameReply(value: unknown): RenameReply {
  if (!isRecord(value)) return unreadable();
  const { written, name } = value;
  const member = memberRef(value["member"]);
  if (!isBoolean(written) || !isString(name) || member === undefined) return unreadable();
  return { written, member, name };
}

export function parseLeaveReply(value: unknown): LeaveReply {
  if (!isRecord(value)) return unreadable();
  const { signed, revokeCommand, machinesKept } = value;
  const members = memberRefs(value["members"]);
  const confirmed = memberRefs(value["confirmed"]);
  if (!isBoolean(signed) || members === undefined || confirmed === undefined) return unreadable();
  if (revokeCommand !== null && !isString(revokeCommand)) return unreadable();
  if (machinesKept !== null && !isString(machinesKept)) return unreadable();
  return { signed, members, confirmed, revokeCommand, machinesKept };
}
