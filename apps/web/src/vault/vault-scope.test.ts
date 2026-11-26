import { describe, expect, test } from "bun:test";
import type { MemberSigner } from "@doriface/vault";
import { DEFAULT_SETTINGS, type ConnectionSettings } from "../connection/settings.ts";
import type { ConnectionState } from "../connection/store.ts";
import type { BundleView } from "../mesh/bundle-view.ts";
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
  return { a, b, views };
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
