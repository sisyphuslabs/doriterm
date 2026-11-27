import { describe, expect, test } from "bun:test";
import type { HcConnection } from "@doriface/client";
import { base64urlEncode } from "@doriface/crypto";
import { type MemberSigner, VAULT_DOC } from "@doriface/vault";
import { DEFAULT_SETTINGS, type ConnectionSettings } from "../connection/settings.ts";
import type { ConnectionState } from "../connection/store.ts";
import type { BundleView } from "../mesh/bundle-view.ts";
import { beginRetire } from "../mesh/enrollment.ts";
import { loadSignKey } from "../mesh/identity.ts";
import { SlotNotEnrolled, slotKeys } from "../mesh/identity-slots.ts";
import { joinedStore, meshFixture } from "../mesh/mesh-fixture.test-support.ts";
import { contextOf } from "../mesh/mesh-context.ts";
import { memoryStore } from "../storage/idb.ts";
import { vaultScope } from "./vault-scope.ts";

/** Two meshes held side by side, as their stores show them: the first on the default identity, the second on "b". */
async function twoMeshes() {
  const storage = memoryStore();
  const a = meshFixture(["alpha"]);
  const b = meshFixture(["beta"]);
  const views = new Map<string, BundleView>([
    ["", (await joinedStore(storage, a, "")).snapshot()],
    ["b", (await joinedStore(storage, b, "b")).snapshot()],
  ]);
  return { a, b, views, storage };
}

/** An authenticated session to the selected machine, recording every call the vault makes on it. */
function session(peers: readonly string[]) {
  const calls: { readonly method: string; readonly params: unknown }[] = [];
  const connection = {
    call: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method === "machine.list") return { machines: peers.map((name) => ({ name, state: "connected" })) };
      return { value: null, version: 0 };
    },
  } as unknown as HcConnection;
  const state: ConnectionState = { phase: "open", connection, path: "relay" };
  return { calls, state };
}

const learned = (hostId: string, keySlot: string | undefined, meshId: string): ConnectionSettings => ({
  ...DEFAULT_SETTINGS,
  hostId,
  viewMember: true,
  keySlot,
  meshId,
});

const OFFLINE: ConnectionState = { phase: "unconfigured" };

const keyless = async (): Promise<MemberSigner> => {
  throw new Error("no key may be loaded without a membership");
};

describe("the vault's membership comes from the selected machine (review of #2890)", () => {
  test("its replicas are the selected machine's authenticated session and its peers, and its key is refused once that mesh is left", async () => {
    const { b, views, storage } = await twoMeshes();
    const selected = learned(b.hostIds[0] ?? "", "b", b.membership.meshId);
    const live = session(["beta-peer"]);
    const later = session(["elsewhere"]);
    let current = live.state;
    const signer = async (slot: string): Promise<MemberSigner> => {
      const card = await loadSignKey(slotKeys(storage, slot), null);
      return { signPub: base64urlEncode(card.publicKey), sign: (message) => card.sign(message) };
    };
    const scope = await vaultScope({ context: () => contextOf(selected, views), connection: () => current, signer });
    if (scope === undefined) throw new Error("the selected machine's mesh gave no vault scope");
    current = later.state;
    const replicas = await scope.replicas();
    expect(replicas.map((replica) => replica.on)).toEqual([null, "beta-peer"]);
    await replicas[1]?.get();
    expect(live.calls).toEqual([
      { method: "machine.list", params: undefined },
      { method: "doc.get", params: { name: VAULT_DOC, on: "beta-peer" } },
    ]);
    expect(later.calls).toEqual([]);
    await scope.member.self.sign(new Uint8Array([1]));
    await beginRetire(storage, "b");
    await expect(scope.member.self.sign(new Uint8Array([1]))).rejects.toBeInstanceOf(SlotNotEnrolled);
  });

  test("a machine of the second mesh selected: the vault signs as the second mesh, never with the first's key", async () => {
    const { a, b, views } = await twoMeshes();
    const signed: string[] = [];
    const signer = async (slot: string): Promise<MemberSigner> => {
      signed.push(slot);
      return { signPub: slot === "b" ? b.keys.signPub : a.keys.signPub, sign: async () => new Uint8Array(64) };
    };
    const selected = learned(b.hostIds[0] ?? "", "b", b.membership.meshId);
    const scope = await vaultScope({ context: () => contextOf(selected, views), connection: () => OFFLINE, signer });
    expect(signed).toEqual(["b"]);
    expect(scope?.member.mesh).toBe(b.membership.meshId);
    expect(scope?.member.self.signPub).toBe(b.keys.signPub);
    expect(scope?.member.members.has(b.keys.signPub)).toBe(true);
    expect(scope?.member.members.has(a.keys.signPub)).toBe(false);
  });

  test("a paired machine is the default identity's, when that mesh lists it", async () => {
    const { a, views } = await twoMeshes();
    const paired = { ...DEFAULT_SETTINGS, hostId: a.hostIds[0] ?? "" };
    expect(contextOf(paired, views)?.slot).toBe("");
  });

  test("fails closed: another mesh named, a machine the mesh does not list, or a membership that is gone", async () => {
    const { a, b, views } = await twoMeshes();
    const bHost = b.hostIds[0] ?? "";
    expect(contextOf(learned(bHost, "b", a.membership.meshId), views)).toBeUndefined();
    expect(contextOf(learned(a.hostIds[0] ?? "", "b", b.membership.meshId), views)).toBeUndefined();
    const secondGone = new Map(views);
    secondGone.delete("b");
    expect(contextOf(learned(bHost, "b", b.membership.meshId), secondGone)).toBeUndefined();
    expect(await vaultScope({ context: () => undefined, connection: () => OFFLINE, signer: keyless })).toBeUndefined();
  });
});
