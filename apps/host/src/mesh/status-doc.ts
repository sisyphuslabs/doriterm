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

/**
 * Writes this host's status to the `doriface-mesh` document unless it already holds exactly that. Any client can write
 * the document, so a `conflict` means it moved since the read, possibly by a newer publish of this host's own. Each
 * attempt therefore reads the document and asks `current` for the status as it is now: a retry never writes the
 * snapshot an earlier attempt started with over a newer one.
 */
export async function publishMeshStatus(
  store: DocStore,
  current: () => MeshStatus,
  attempt = 1,
): Promise<"written" | "unchanged"> {
  const doc = await store.get(MESH_STATUS_DOC);
  const status = current();
  if (isJsonObject(doc.value) && Bun.deepEquals(doc.value, status)) return "unchanged";
  try {
    await store.set(MESH_STATUS_DOC, status, doc.version);
    return "written";
  } catch (error) {
    if (!isConflict(error) || attempt >= ATTEMPTS) throw error;
    return publishMeshStatus(store, current, attempt + 1);
  }
}
