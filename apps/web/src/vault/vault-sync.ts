import { HcRpcError, type JsonValue } from "@doriface/protocol";
import { EMPTY_VAULT, mergeVaults, parseVaultDoc, type VaultDoc } from "@doriface/vault";

/** One machine's copy of the `doriface-vault` document: `on` is the machine's name, null for the connected core. */
export interface VaultReplica {
  readonly on: string | null;
  get(): Promise<{ readonly value: JsonValue; readonly version: number }>;
  set(value: JsonValue, version: number): Promise<{ readonly version: number }>;
}

export interface VaultSync {
  readonly doc: VaultDoc;
  /** Machines that could not be read or written this round; the next sync tries them again. */
  readonly failed: readonly { readonly on: string | null; readonly message: string }[];
}

const asJson = (doc: VaultDoc): JsonValue => JSON.parse(JSON.stringify(doc));
/** JSON with object keys sorted, so two equal documents compare equal whatever order their keys were written in. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "object" && item !== null && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
const isConflict = (cause: unknown): boolean => cause instanceof HcRpcError && cause.kind === "conflict";

/** Three lost races in a row means something rewrites the copy in a loop; the next sync tries again. */
const ATTEMPTS = 3;

/** Writes `doc` over this copy unless it already holds it; a lost race re-reads the copy and merges it in first. */
async function writeBack(
  replica: VaultReplica,
  doc: VaultDoc,
  version: number,
  held: VaultDoc,
  merge: (a: VaultDoc, b: VaultDoc) => VaultDoc,
  attempt = 1,
): Promise<VaultDoc> {
  if (canonical(held) === canonical(doc)) return doc;
  try {
    await replica.set(asJson(doc), version);
    return doc;
  } catch (cause) {
    if (!isConflict(cause) || attempt >= ATTEMPTS) throw cause;
  }
  const again = await replica.get();
  const current = parseVaultDoc(again.value);
  return writeBack(replica, merge(doc, current), again.version, current, merge, attempt + 1);
}

/**
 * One round of anti-entropy: read every machine's copy, merge them, let `step` (this device's maintenance or write) act
 * on the merge, and write the result back to each machine whose copy differs. Machines only store the document; every
 * check of what it holds happens in `step` and on read. A lost compare-and-set race re-reads that copy and merges it in.
 */
export async function syncVault(
  replicas: readonly VaultReplica[],
  step: (merged: VaultDoc) => Promise<VaultDoc>,
  mesh: string,
): Promise<VaultSync> {
  const merge = (a: VaultDoc, b: VaultDoc): VaultDoc => mergeVaults(a, b, mesh);
  const failed: { on: string | null; message: string }[] = [];
  const read = await Promise.all(
    replicas.map(async (replica) => {
      try {
        const { value, version } = await replica.get();
        return [{ replica, version, doc: parseVaultDoc(value) }];
      } catch (cause) {
        failed.push({ on: replica.on, message: messageOf(cause) });
        return [];
      }
    }),
  );
  const copies = read.flat();
  if (copies.length === 0) throw new Error("no machine holds the mesh vault right now");
  // Every copy goes through the merge, which drops whatever is not signed by who it claims, before `step` sees it.
  const merged = copies.reduce((doc, copy) => merge(doc, copy.doc), EMPTY_VAULT);
  let result = await step(merged);
  const written = await Promise.all(
    copies.map(async (copy) => {
      try {
        return await writeBack(copy.replica, result, copy.version, copy.doc, merge);
      } catch (cause) {
        failed.push({ on: copy.replica.on, message: messageOf(cause) });
        return result;
      }
    }),
  );
  result = written.reduce(merge, result);
  return { doc: result, failed };
}
