import type { HcConnection } from "@doriface/client";
import { HcRpcError, isJsonObject, type JsonValue, MESH_STATUS_DOC, type MeshStatus } from "@doriface/protocol";

/** herdr's documents: `doc.get` and a `doc.set` that refuses with `conflict` when the version moved. */
export interface DocStore {
  get(name: string): Promise<{ readonly value: JsonValue; readonly version: number }>;
  set(name: string, value: JsonValue, version: number): Promise<{ readonly version: number }>;
}

export const docStoreOf = (connection: Pick<HcConnection, "call">): DocStore => ({
  get: (name) => connection.call("doc.get", { name }),
  set: (name, value, version) => connection.call("doc.set", { name, value, version }),
});

const isConflict = (error: unknown): boolean => error instanceof HcRpcError && error.kind === "conflict";

/** A writer between our read and our write; three in a row means something rewrites the document in a loop. */
const ATTEMPTS = 3;

/** What a publish did: wrote the status, cleared this host's own stale document, or found the document already right. */
export type MeshStatusPublish = "written" | "cleared" | "unchanged";

/**
 * Writes this host's status to the `doriface-mesh` document unless it already holds exactly that. A host in no mesh
 * clears only a document that names it as `self`: any host and any fixture on the same core can write this document, and
 * deleting one that belongs to somebody else would take the mesh another host is publishing away from every reader. Any
 * client can write the document, so a `conflict` means it moved since the read, possibly by a newer publish of this
 * host's own. Each attempt therefore reads the document and asks `current` for the status as it is now: a retry never
 * writes the snapshot an earlier attempt started with over a newer one.
 */
export function publishMeshStatus(
  store: DocStore,
  current: () => MeshStatus | undefined,
  self: string,
): Promise<MeshStatusPublish> {
  return attemptPublish(store, current, self, 1);
}

/**
 * This host's own document left over from a mesh it has left: its `self` field is us, and we are in no mesh. Only that
 * field is read, not the whole document: a document this host wrote in a shape the current parser refuses (an older
 * version, or one no longer consistent) is still ours to clear (#809).
 */
const ours = (value: JsonValue, self: string): boolean => isJsonObject(value) && value["self"] === self;

async function attemptPublish(
  store: DocStore,
  current: () => MeshStatus | undefined,
  self: string,
  attempt: number,
): Promise<MeshStatusPublish> {
  const doc = await store.get(MESH_STATUS_DOC);
  const status = current();
  if (status === undefined && !ours(doc.value, self)) return "unchanged";
  if (status !== undefined && isJsonObject(doc.value) && Bun.deepEquals(doc.value, status)) return "unchanged";
  try {
    await store.set(MESH_STATUS_DOC, status ?? null, doc.version);
    return status === undefined ? "cleared" : "written";
  } catch (error) {
    if (!isConflict(error) || attempt >= ATTEMPTS) throw error;
    return attemptPublish(store, current, self, attempt + 1);
  }
}
