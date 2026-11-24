import { describe, expect, test } from "bun:test";
import { HcRpcError, type JsonValue } from "@doriface/protocol";
import { EMPTY_VAULT, mergeVaults, parseVaultDoc, type VaultDoc } from "@doriface/vault";
import { syncVault, type VaultReplica } from "./vault-sync.ts";

interface Held {
  value: JsonValue;
  version: number;
}

function replica(on: string | null, held: Held, options: { conflictOnce?: () => void; down?: boolean } = {}) {
  let conflicts = options.conflictOnce === undefined ? 0 : 1;
  const writes: JsonValue[] = [];
  const self: VaultReplica & { readonly writes: JsonValue[] } = {
    on,
    writes,
    get: async () => {
      if (options.down === true) throw new Error("machine unreachable");
      return { value: held.value, version: held.version };
    },
    set: async (value, version) => {
      if (conflicts > 0) {
        conflicts -= 1;
        options.conflictOnce?.();
        throw new HcRpcError({ code: -32000, message: "version moved", data: { kind: "conflict" } });
      }
      if (version !== held.version) throw new Error("test replica: stale version");
      held.value = value;
      held.version += 1;
      writes.push(value);
      return { version: held.version };
    },
  };
  return self;
}

/** A well-formed envelope under a recognisable id; merge keeps it as is (signatures are checked on read). */
const withDevice = (doc: VaultDoc, tag: string): VaultDoc => {
  const id = `mesh.${tag
    .padEnd(32, "0")
    .replace(/[^0-9a-f]/g, "0")
    .slice(0, 32)}`;
  const envelope = {
    v: 1,
    id,
    tier: "mesh",
    gen: 1,
    rev: 1,
    at: "2026-11-24T00:00:00.000Z",
    payload: tag,
    signer: { kind: "owner" },
    sig: tag,
  } as const;
  return { ...doc, entries: { ...doc.entries, [id]: envelope } };
};
const tags = (doc: VaultDoc): string[] =>
  Object.values(doc.entries)
    .map((entry) => entry.payload)
    .toSorted();
const asJson = (doc: VaultDoc): JsonValue => JSON.parse(JSON.stringify(doc));

describe("syncVault", () => {
  test("merges every reachable copy, applies the step once, and writes the result where it differs", async () => {
    const a = replica(null, { value: asJson(withDevice(EMPTY_VAULT, "a")), version: 3 });
    const b = replica("other", { value: null, version: 0 });
    const step = async (doc: VaultDoc) => withDevice(doc, "c");
    const result = await syncVault([a, b], step);
    expect(tags(result.doc)).toEqual(["a", "c"]);
    expect(parseVaultDoc(a.writes.at(-1))).toEqual(result.doc);
    expect(parseVaultDoc(b.writes.at(-1))).toEqual(result.doc);
    expect(result.failed).toEqual([]);
  });

  test("leaves a copy that already holds the result untouched", async () => {
    const doc = withDevice(EMPTY_VAULT, "a");
    const a = replica(null, { value: asJson(doc), version: 1 });
    await syncVault([a], async (merged) => merged);
    expect(a.writes).toEqual([]);
  });

  test("a write that lost a race re-reads that copy and keeps both changes", async () => {
    const held: Held = { value: asJson(withDevice(EMPTY_VAULT, "a")), version: 1 };
    const racing = replica(null, held, {
      conflictOnce: () => {
        held.value = asJson(withDevice(parseVaultDoc(held.value), "raced"));
        held.version += 1;
      },
    });
    const result = await syncVault([racing], async (doc) => withDevice(doc, "mine"));
    expect(tags(parseVaultDoc(held.value))).toEqual(["a", "mine", "raced"]);
    expect(result.doc).toEqual(parseVaultDoc(held.value));
  });

  test("an unreachable machine is reported and the others still sync; none reachable is an error", async () => {
    const up = replica(null, { value: null, version: 0 });
    const down = replica("away", { value: null, version: 0 }, { down: true });
    const result = await syncVault([up, down], async (doc) => withDevice(doc, "a"));
    expect(result.failed).toEqual([{ on: "away", message: "machine unreachable" }]);
    expect(up.writes).toHaveLength(1);
    await expect(syncVault([down], async (doc) => doc)).rejects.toThrow("no machine");
  });

  test("the merge is the same whichever copy answers first", () => {
    const x = withDevice(EMPTY_VAULT, "x");
    const y = withDevice(EMPTY_VAULT, "y");
    expect(mergeVaults(x, y)).toEqual(mergeVaults(y, x));
  });
});
