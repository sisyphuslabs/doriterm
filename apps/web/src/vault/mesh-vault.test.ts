import { describe, expect, test } from "bun:test";
import type { JsonValue } from "@doriface/protocol";
import { contextOf, testDevice } from "../../../../packages/vault/src/testing.ts";
import { memoryStore } from "../storage/idb.ts";
import { MeshVault, type MeshVaultDeps, SONIOX_ENTRY } from "./mesh-vault.ts";
import type { VaultReplica } from "./vault-sync.ts";

function machine(): VaultReplica {
  let held: { value: JsonValue; version: number } = { value: null, version: 0 };
  return {
    on: null,
    get: async () => held,
    set: async (value, version) => {
      if (version !== held.version) throw new Error("stale");
      held = { value, version: version + 1 };
      return { version: held.version };
    },
  };
}

async function device(replica: VaultReplica, members: () => readonly string[]) {
  const me = await testDevice();
  const base = contextOf(me, []);
  const deps: MeshVaultDeps = {
    scope: async () => ({
      member: { mesh: base.mesh, members: new Set(members()), removed: new Set<string>(), self: me.signer },
      replicas: async () => [replica],
    }),
    key: async () => me.key,
    storage: memoryStore(),
    now: base.now,
  };
  return { me, vault: new MeshVault(deps) };
}

describe("the Soniox entry through the mesh vault", () => {
  test("saved on one device, opened on another once it was wrapped, with no password; settings carry no key", async () => {
    const shared = machine();
    const signPubs: string[] = [];
    const laptop = await device(shared, () => signPubs);
    const phone = await device(shared, () => signPubs);
    signPubs.push(laptop.me.signPub, phone.me.signPub);

    await laptop.vault.sync();
    await phone.vault.sync();
    await laptop.vault.saveSoniox({ apiKey: "sk-live", model: "stt-rt-v6", baseUrl: "https://api.soniox.com" });
    expect(laptop.vault.snapshot.soniox).toMatchObject({ kind: "saved", model: "stt-rt-v6", openers: 2 });
    expect(JSON.stringify(laptop.vault.snapshot)).not.toContain("sk-live");

    await phone.vault.sync();
    expect(phone.vault.snapshot.soniox.kind).toBe("saved");
    expect((await phone.vault.sonioxKey())?.apiKey).toBe("sk-live");
    expect(SONIOX_ENTRY).toBe("soniox");
  });

  test("with no connection the vault says why instead of loading forever", async () => {
    const signPubs: string[] = [];
    const member = await device(machine(), () => signPubs);
    signPubs.push(member.me.signPub);
    await member.vault.offline();
    expect(member.vault.snapshot.phase).toBe("offline");
    const outsider = await device(machine(), () => []);
    await outsider.vault.offline();
    expect(outsider.vault.snapshot.phase).toBe("not-member");
  });

  test("a device outside the mesh cannot use the vault", async () => {
    const outsider = await device(machine(), () => []);
    await outsider.vault.sync();
    expect(outsider.vault.snapshot.phase).toBe("not-member");
  });
});
