import { describe, expect, test } from "bun:test";
import { HcRpcError, type JsonValue } from "@doriface/protocol";
import { EMPTY_VAULT, maintain, mergeVaults, parseVaultDoc, type VaultDoc } from "@doriface/vault";
import { contextOf, MESH, testDevice, type TestDevice } from "../../../../packages/vault/src/testing.ts";
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

const asJson = (doc: VaultDoc): JsonValue => JSON.parse(JSON.stringify(doc));
const announcers = (doc: VaultDoc): string[] => Object.keys(doc.devices).toSorted();

async function members(
  count: number,
): Promise<{ devices: TestDevice[]; announce: (doc: VaultDoc, at: number) => Promise<VaultDoc> }> {
  const devices = await Promise.all(Array.from({ length: count }, () => testDevice()));
  const ctx = (at: number) => {
    const device = devices[at];
    if (device === undefined) throw new Error("no such device");
    return contextOf(device, devices);
  };
  return { devices, announce: (doc, at) => maintain(doc, ctx(at)) };
}

describe("syncVault", () => {
  test("merges every reachable copy, applies the step once, and writes the result where it differs", async () => {
    const { devices, announce } = await members(2);
    const a = replica(null, { value: asJson(await announce(EMPTY_VAULT, 0)), version: 3 });
    const b = replica("other", { value: null, version: 0 });
    const result = await syncVault([a, b], (doc) => announce(doc, 1), MESH);
    expect(announcers(result.doc)).toEqual(devices.map((device) => device.signPub).toSorted());
    expect(parseVaultDoc(a.writes.at(-1))).toEqual(result.doc);
    expect(parseVaultDoc(b.writes.at(-1))).toEqual(result.doc);
    expect(result.failed).toEqual([]);
  });

  test("leaves a copy that already holds the result untouched", async () => {
    const { announce } = await members(1);
    const doc = await announce(EMPTY_VAULT, 0);
    const a = replica(null, { value: asJson(doc), version: 1 });
    await syncVault([a], async (merged) => merged, MESH);
    expect(a.writes).toEqual([]);
  });

  test("never writes an item that is not signed by who it claims to another machine", async () => {
    const { devices, announce } = await members(1);
    const genuine = await announce(EMPTY_VAULT, 0);
    const signPub = devices[0]?.signPub ?? "";
    const forged = {
      ...genuine,
      devices: { [signPub]: { body: "{}", sig: "forged" }, intruder: { body: "{}", sig: "x" } },
    };
    const hostile = replica(null, { value: asJson(forged), version: 1 });
    const honest = replica("other", { value: asJson(genuine), version: 1 });
    const result = await syncVault([hostile, honest], async (doc) => doc, MESH);
    expect(result.doc).toEqual(mergeVaults(EMPTY_VAULT, genuine, MESH));
    expect(honest.writes).toEqual([]);
  });

  test("a write that lost a race re-reads that copy and keeps both changes", async () => {
    const { devices, announce } = await members(3);
    const held: Held = { value: asJson(await announce(EMPTY_VAULT, 0)), version: 1 };
    const raced = await announce(parseVaultDoc(held.value), 1);
    const conflict = replica(null, held, {
      conflictOnce: () => {
        held.value = asJson(raced);
        held.version += 1;
      },
    });
    const result = await syncVault([conflict], (doc) => announce(doc, 2), MESH);
    expect(announcers(parseVaultDoc(held.value))).toEqual(devices.map((device) => device.signPub).toSorted());
    expect(result.doc).toEqual(parseVaultDoc(held.value));
  });

  test("an unreachable machine is reported and the others still sync; none reachable is an error", async () => {
    const { announce } = await members(1);
    const up = replica(null, { value: null, version: 0 });
    const down = replica("away", { value: null, version: 0 }, { down: true });
    const result = await syncVault([up, down], (doc) => announce(doc, 0), MESH);
    expect(result.failed).toEqual([{ on: "away", message: "machine unreachable" }]);
    expect(up.writes).toHaveLength(1);
    await expect(syncVault([down], async (doc) => doc, MESH)).rejects.toThrow("no machine");
  });
});
