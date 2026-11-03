import { isJsonObject } from "./json.ts";
import {
  type Guard,
  isBoolean,
  isCount,
  isFingerprint,
  isId,
  isName,
  isString,
  isTime,
  listOf,
  nullable,
  objectOf,
  oneOf,
  type Shape,
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
  type MeshRemovedStatus,
  type MeshRevokedStatus,
  type MeshStatus,
  type MeshStuckReason,
} from "./mesh-status.ts";

type StuckKind = MeshStuckReason["kind"];
type StuckOf<K extends StuckKind> = Extract<MeshStuckReason, { readonly kind: K }>;

/** One guard per STUCK kind; `satisfies` makes a kind added to MeshStuckReason without a guard a type error. */
const STUCK_REASONS = {
  name_taken: objectOf<StuckOf<"name_taken">>({ kind: oneOf("name_taken"), member: isId, name: isName }),
  invalid_name: objectOf<StuckOf<"invalid_name">>({
    kind: oneOf("invalid_name"),
    member: isId,
    name: isString,
    message: isString,
  }),
  copied_core: objectOf<StuckOf<"copied_core">>({ kind: oneOf("copied_core"), member: isId }),
  line_idle: objectOf<StuckOf<"line_idle">>({ kind: oneOf("line_idle"), member: isId }),
  possibly_revoked: objectOf<StuckOf<"possibly_revoked">>({ kind: oneOf("possibly_revoked") }),
  read_only: objectOf<StuckOf<"read_only">>({
    kind: oneOf("read_only"),
    until: isTime,
    by: listOf(isId),
    at: nullable(isTime),
  }),
  removed_undecidable: objectOf<StuckOf<"removed_undecidable">>({ kind: oneOf("removed_undecidable") }),
  log_full: objectOf<StuckOf<"log_full">>({ kind: oneOf("log_full"), records: isCount }),
  counter_behind: objectOf<StuckOf<"counter_behind">>({ kind: oneOf("counter_behind"), file: isCount, mesh: isCount }),
} satisfies { readonly [K in StuckKind]: Guard<StuckOf<K>> };

const isStuckKind = (kind: unknown): kind is StuckKind =>
  typeof kind === "string" && Object.hasOwn(STUCK_REASONS, kind);

function isStuckReason(value: unknown): value is MeshStuckReason {
  if (!isJsonObject(value)) return false;
  const kind = value["kind"];
  return isStuckKind(kind) && STUCK_REASONS[kind](value);
}

const isLineState: Guard<MeshLineState> = oneOf(
  "self",
  "connected",
  "connecting",
  "unreachable",
  "hc_missing",
  "incompatible",
  "needs_login",
  "absent",
);
const isText = (value: unknown): value is string => isString(value) && value.length > 0;
const isGate = objectOf<MeshGate>({ kind: oneOf("offline"), refusals: isCount, nextProbeAt: isTime });
const isMember = objectOf<MeshMemberStatus>({
  hostId: isId,
  name: isName,
  localName: isName,
  fingerprint: isFingerprint,
  admittedBy: nullable(isId),
  overCap: isBoolean,
  line: isLineState,
  lineReason: nullable(isText),
  helloCoreId: nullable(isText),
  replacedMachine: nullable(isName),
  presence: isBoolean,
  lastSync: nullable(isTime),
  owed: isCount,
  gate: nullable(isGate),
  witnessPool: listOf(isId),
  witnessAsk: nullable(isId),
  unreachableSince: nullable(isTime),
  revokeSuggested: isBoolean,
});
const isRevoked = objectOf<MeshRevokedStatus>({
  hostId: isId,
  name: isName,
  fingerprint: isFingerprint,
  revokedBy: listOf(isId),
  reason: oneOf("revoke", "compromised", "leave"),
  at: nullable(isTime),
});
const isEntry = objectOf<{ readonly hostId: string; readonly name: string }>({ hostId: isId, name: isName });
const isRemoved = objectOf<MeshRemovedStatus>({ members: listOf(isEntry), revokedKey: isEntry });
const isNotice = objectOf<MeshNotice>({
  hostId: isId,
  name: isName,
  admittedBy: isId,
  fingerprint: isFingerprint,
  seenAt: isTime,
  until: isTime,
});
const isPending = objectOf<MeshPendingJoin>({
  nonce: isString,
  name: isName,
  hostId: isId,
  fingerprint: isFingerprint,
  expiresAt: isTime,
});
const isBudget = objectOf<MeshBudget>({ waiting: isCount, halvedUntil: nullable(isTime) });

const STATUS: Shape<MeshStatus> = {
  v: (value): value is typeof MESH_STATUS_VERSION => value === MESH_STATUS_VERSION,
  meshId: isId,
  self: isId,
  generation: isCount,
  sync: oneOf("ok", "stuck"),
  stuck: listOf(isStuckReason),
  members: listOf(isMember),
  revoked: listOf(isRevoked),
  removed: listOf(isRemoved),
  notices: listOf(isNotice),
  pending: listOf(isPending),
  budget: isBudget,
};
const isMeshStatus = objectOf(STATUS);

/** What the fields' forms cannot say: one fact in one place, and every member a reason names is in the list. */
function isConsistent(status: MeshStatus): boolean {
  const hostIds = new Set(status.members.map((member) => member.hostId));
  const onSelfLine = status.members.filter((member) => member.line === "self");
  return (
    status.sync === (status.stuck.length === 0 ? "ok" : "stuck") &&
    hostIds.size === status.members.length &&
    onSelfLine.length === 1 &&
    onSelfLine[0]?.hostId === status.self &&
    status.members.every(
      (member) => member.lineReason === null || MESH_LINE_STATES_WITH_REASON.includes(member.line),
    ) &&
    status.members.every(
      (member) => !member.revokeSuggested || (member.line !== "self" && member.unreachableSince !== null),
    ) &&
    status.stuck.every((reason) => !("member" in reason) || hostIds.has(reason.member))
  );
}

/**
 * The status in a `doriface-mesh` document or a `mesh-status` reply, or undefined when it has another shape or
 * contradicts itself. Top-level members a newer writer added are dropped; nested objects are closed.
 */
export function parseMeshStatus(value: unknown): MeshStatus | undefined {
  if (!isJsonObject(value)) return undefined;
  const known = Object.fromEntries(
    Object.keys(STATUS)
      .filter((key) => Object.hasOwn(value, key))
      .map((key) => [key, value[key]]),
  );
  return isMeshStatus(known) && isConsistent(known) ? known : undefined;
}
