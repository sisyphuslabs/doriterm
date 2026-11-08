import { isJsonObject } from "./json.ts";
import {
  listOf,
  nullable,
  objectOf,
  oneOf,
  type Reader,
  readBoolean,
  readCount,
  readFingerprint,
  readId,
  readName,
  readString,
  readTime,
  type Shape,
  when,
} from "./mesh-status-guards.ts";
import {
  MESH_LINE_STATES_WITH_REASON,
  MESH_STATUS_VERSION,
  type MeshBudget,
  type MeshGate,
  type MeshLineState,
  type MeshMemberStatus,
  type MeshNotice,
  type MeshPendingJoin,
  type MeshReplacedMachine,
  type MeshRemovedStatus,
  type MeshRevokedStatus,
  type MeshStatus,
  type MeshStuckReason,
} from "./mesh-status.ts";

type StuckKind = MeshStuckReason["kind"];
type StuckOf<K extends StuckKind> = Extract<MeshStuckReason, { readonly kind: K }>;

/** One reader per STUCK kind; `satisfies` makes a kind added to MeshStuckReason without a reader a type error. */
const STUCK_REASONS = {
  name_taken: objectOf<StuckOf<"name_taken">>({ kind: oneOf("name_taken"), member: readId, name: readName }),
  invalid_name: objectOf<StuckOf<"invalid_name">>({
    kind: oneOf("invalid_name"),
    member: readId,
    name: readString,
    message: readString,
  }),
  copied_core: objectOf<StuckOf<"copied_core">>({ kind: oneOf("copied_core"), member: readId }),
  line_idle: objectOf<StuckOf<"line_idle">>({ kind: oneOf("line_idle"), member: readId }),
  possibly_revoked: objectOf<StuckOf<"possibly_revoked">>({ kind: oneOf("possibly_revoked") }),
  read_only: objectOf<StuckOf<"read_only">>({
    kind: oneOf("read_only"),
    until: readTime,
    by: listOf(readId),
    at: nullable(readTime),
  }),
  removed_undecidable: objectOf<StuckOf<"removed_undecidable">>({ kind: oneOf("removed_undecidable") }),
  log_full: objectOf<StuckOf<"log_full">>({ kind: oneOf("log_full"), records: readCount }),
  counter_behind: objectOf<StuckOf<"counter_behind">>({
    kind: oneOf("counter_behind"),
    file: readCount,
    mesh: readCount,
  }),
} satisfies { readonly [K in StuckKind]: Reader<StuckOf<K>> };

const isStuckKind = (kind: unknown): kind is StuckKind =>
  typeof kind === "string" && Object.hasOwn(STUCK_REASONS, kind);

function readStuckReason(value: unknown): MeshStuckReason | undefined {
  if (!isJsonObject(value)) return undefined;
  const kind = value["kind"];
  return isStuckKind(kind) ? STUCK_REASONS[kind](value) : undefined;
}

const readLineState: Reader<MeshLineState> = oneOf(
  "self",
  "connected",
  "connecting",
  "unreachable",
  "hc_missing",
  "incompatible",
  "needs_login",
  "absent",
);
const readText = when((value): value is string => typeof value === "string" && value.length > 0);
const readGate = objectOf<MeshGate>({ kind: oneOf("offline"), refusals: readCount, nextProbeAt: readTime });
const readReplaced = objectOf<MeshReplacedMachine>({ name: readName, kind: oneOf("ssh", "connect", "command") });
const readMemberBase = objectOf<Omit<MeshMemberStatus, "lastSessionAt">>({
  hostId: readId,
  name: nullable(readName),
  localName: nullable(readName),
  fingerprint: nullable(readFingerprint),
  admittedBy: nullable(readId),
  overCap: readBoolean,
  line: readLineState,
  lineReason: nullable(readText),
  helloCoreId: nullable(readText),
  replacedMachine: nullable(readReplaced),
  presence: readBoolean,
  lastSync: nullable(readTime),
  owed: readCount,
  gate: nullable(readGate),
  witnessPool: listOf(readId),
  witnessAsk: nullable(readId),
  unreachableSince: nullable(readTime),
  revokeSuggested: readBoolean,
});
const readMember: Reader<MeshMemberStatus> = (value) => {
  const base = readMemberBase(value);
  if (base === undefined || !isJsonObject(value)) return undefined;
  const supplied = value["lastSessionAt"];
  const lastSessionAt = supplied === undefined ? undefined : readCount(supplied);
  if (supplied !== undefined && lastSessionAt === undefined) return undefined;
  return { ...base, ...(lastSessionAt === undefined ? {} : { lastSessionAt }) };
};
const readRevoked = objectOf<MeshRevokedStatus>({
  hostId: readId,
  name: readName,
  localName: readName,
  fingerprint: readFingerprint,
  revokedBy: listOf(readId),
  reason: oneOf("revoke", "compromised", "leave"),
  at: nullable(readTime),
});
const readEntry = objectOf<{ readonly hostId: string; readonly name: string }>({ hostId: readId, name: readName });
const readRemoved = objectOf<MeshRemovedStatus>({ members: listOf(readEntry), revokedKey: readEntry });
const readNotice = objectOf<MeshNotice>({
  hostId: readId,
  name: readName,
  admittedBy: readId,
  fingerprint: readFingerprint,
  seenAt: readTime,
  until: readTime,
});
const readPendingBase = objectOf<Omit<MeshPendingJoin, "code" | "joinerConfirmed">>({
  nonce: readString,
  name: readName,
  hostId: readId,
  fingerprint: readFingerprint,
  expiresAt: readTime,
  kind: oneOf("machine", "client"),
});
const readPending: Reader<MeshPendingJoin> = (value) => {
  const base = readPendingBase(value);
  if (base === undefined || !isJsonObject(value)) return undefined;
  const code = value["code"];
  const joinerConfirmed = value["joinerConfirmed"];
  if (code !== undefined && (typeof code !== "string" || !/^\d{3} \d{3}$/.test(code))) return undefined;
  if (joinerConfirmed !== undefined && typeof joinerConfirmed !== "boolean") return undefined;
  return {
    ...base,
    ...(code === undefined ? {} : { code }),
    ...(joinerConfirmed === undefined ? {} : { joinerConfirmed }),
  };
};
const readBudget = objectOf<MeshBudget>({ waiting: readCount, halvedUntil: nullable(readTime) });

const STATUS: Shape<MeshStatus> = {
  v: when((value): value is typeof MESH_STATUS_VERSION => value === MESH_STATUS_VERSION),
  meshId: readId,
  self: readId,
  generation: readCount,
  sync: oneOf("ok", "stuck"),
  stuck: listOf(readStuckReason),
  members: listOf(readMember),
  revoked: listOf(readRevoked),
  removed: listOf(readRemoved),
  notices: listOf(readNotice),
  pending: listOf(readPending),
  budget: readBudget,
};
const readMeshStatus = objectOf(STATUS);

/** The reasons a host is outside its own view (design 6.4, 3.7): then it has no self line, and says which. */
const OUTSIDE_OWN_VIEW: ReadonlySet<MeshStuckReason["kind"]> = new Set([
  "possibly_revoked",
  "read_only",
  "removed_undecidable",
]);

/** What the fields' forms cannot say: one fact in one place, and every member a reason names is in the list. */
function isConsistent(status: MeshStatus): boolean {
  const hostIds = new Set(status.members.map((member) => member.hostId));
  const onSelfLine = status.members.filter((member) => member.line === "self");
  return (
    status.sync === (status.stuck.length === 0 ? "ok" : "stuck") &&
    hostIds.size === status.members.length &&
    (onSelfLine.length === 1
      ? onSelfLine[0]?.hostId === status.self
      : onSelfLine.length === 0 &&
        !hostIds.has(status.self) &&
        status.stuck.some((reason) => OUTSIDE_OWN_VIEW.has(reason.kind))) &&
    status.members.every(
      (member) => member.lineReason === null || MESH_LINE_STATES_WITH_REASON.includes(member.line),
    ) &&
    status.members.every(
      (member) => member.overCap || (member.name !== null && member.localName !== null && member.fingerprint !== null),
    ) &&
    status.members.every(
      (member) => !member.revokeSuggested || (member.line !== "self" && member.unreachableSince !== null),
    ) &&
    status.stuck.every((reason) => !("member" in reason) || hostIds.has(reason.member))
  );
}

/**
 * The status in a `doriface-mesh` document or a `mesh-status` reply, or undefined when it has another shape or
 * contradicts itself. A member a newer writer added to any object is dropped, so a reader keeps reading a host that ships
 * after it (#728); a field the reader knows in another form refuses the document.
 */
export function parseMeshStatus(value: unknown): MeshStatus | undefined {
  const status = readMeshStatus(value);
  return status !== undefined && isConsistent(status) ? status : undefined;
}
