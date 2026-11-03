import { isJsonObject } from "./json.ts";
import {
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
  type MeshWitness,
} from "./mesh-status.ts";

type Guard<T> = (value: unknown) => value is T;
type Shape<T> = { readonly [K in keyof T]-?: Guard<T[K]> };

const isString = (value: unknown): value is string => typeof value === "string";
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const nullable =
  <T>(guard: Guard<T>): Guard<T | null> =>
  (value): value is T | null =>
    value === null || guard(value);
const listOf =
  <T>(guard: Guard<T>): Guard<readonly T[]> =>
  (value): value is readonly T[] =>
    Array.isArray(value) && value.every(guard);
const oneOf =
  <T extends string>(...values: readonly T[]): Guard<T> =>
  (value): value is T =>
    values.some((allowed) => allowed === value);

/** Checks every member the shape names; members it does not name are allowed, for newer writers. */
function objectOf<T>(shape: Shape<T>): Guard<T> {
  return (value): value is T => {
    if (!isJsonObject(value)) return false;
    for (const key in shape) if (!shape[key](value[key])) return false;
    return true;
  };
}

function isStuckReason(value: unknown): value is MeshStuckReason {
  if (!isJsonObject(value)) return false;
  const member = isString(value["member"]);
  switch (value["kind"]) {
    case "name_taken":
      return member && isString(value["name"]);
    case "invalid_name":
      return member && isString(value["name"]) && isString(value["message"]);
    case "copied_core":
    case "line_idle":
      return member;
    case "possibly_revoked":
    case "removed_undecidable":
      return true;
    case "read_only":
      return isString(value["until"]);
    case "log_full":
      return isCount(value["records"]);
    case "counter_behind":
      return isCount(value["file"]) && isCount(value["mesh"]);
    default:
      return false;
  }
}

const isLineState: Guard<MeshLineState> = oneOf(
  "self",
  "connected",
  "connecting",
  "unreachable",
  "needs_login",
  "absent",
);
const isGate = objectOf<MeshGate>({ kind: oneOf("offline"), refusals: isCount, nextProbeS: isCount });
const isWitness = objectOf<MeshWitness>({ pool: listOf(isString), ask: nullable(isString) });
const isMember = objectOf<MeshMemberStatus>({
  hostId: isString,
  name: isString,
  localName: isString,
  fingerprint: isString,
  admittedBy: nullable(isString),
  overCap: isBoolean,
  line: isLineState,
  presence: isBoolean,
  lastSync: nullable(isString),
  owed: isCount,
  gate: nullable(isGate),
  witness: isWitness,
  unreachableSince: nullable(isString),
  revokeCommand: nullable(isString),
});
const isRevoked = objectOf<MeshRevokedStatus>({
  hostId: isString,
  name: isString,
  fingerprint: isString,
  revokedBy: listOf(isString),
  reason: oneOf("revoke", "compromised", "leave"),
  at: nullable(isString),
});
const isEntry = objectOf<{ readonly hostId: string; readonly name: string }>({ hostId: isString, name: isString });
const isRemoved = objectOf<MeshRemovedStatus>({ members: listOf(isEntry), revokedKey: isEntry });
const isNotice = objectOf<MeshNotice>({
  hostId: isString,
  name: isString,
  admittedBy: isString,
  fingerprint: isString,
  seenAt: isString,
  until: isString,
});
const isPending = objectOf<MeshPendingJoin>({
  nonce: isString,
  name: isString,
  hostId: isString,
  fingerprint: isString,
  expiresAt: isString,
});
const isBudget = objectOf<MeshBudget>({ waiting: isCount, halvedUntil: nullable(isString) });

const isMeshStatus = objectOf<MeshStatus>({
  v: (value): value is typeof MESH_STATUS_VERSION => value === MESH_STATUS_VERSION,
  meshId: isString,
  self: isString,
  generation: isCount,
  sync: oneOf("ok", "stuck"),
  stuck: listOf(isStuckReason),
  members: listOf(isMember),
  revoked: listOf(isRevoked),
  removed: listOf(isRemoved),
  notices: listOf(isNotice),
  pending: listOf(isPending),
  budget: isBudget,
});

/** The status in a `doriface-mesh` document or a `mesh-status` reply, or undefined when it has another shape. */
export const parseMeshStatus = (value: unknown): MeshStatus | undefined => (isMeshStatus(value) ? value : undefined);
