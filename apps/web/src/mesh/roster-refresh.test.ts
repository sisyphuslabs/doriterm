import type { HcConnection } from "@doriface/client";
import { describe, expect, test } from "bun:test";
import type { MemberEntry } from "../connection/mesh-connections.ts";
import { memoryStore } from "../storage/idb.ts";
import { type BrowserIdentity, loadBrowserIdentity } from "./identity.ts";
import { slotKeys } from "./identity-slots.ts";
import { joinedStore, meshFixture } from "./mesh-fixture.test-support.ts";
import type { MembershipStore } from "./membership.ts";
import { leaveMembership, refreshFrom, type RosterDeps } from "./roster-refresh.ts";

/** Two meshes, and roster deps that record which slot each step ran as instead of opening a session. */
async function twoMeshes() {
  const storage = memoryStore();
  const first = meshFixture(["alpha"]);
  const second = meshFixture(["beta"]);
  const stores = new Map<string, MembershipStore>([
    ["", await joinedStore(storage, first, "")],
    ["b", await joinedStore(storage, second, "b")],
  ]);
  const identities = new Map<string, BrowserIdentity>(
    await Promise.all(
      [...stores.keys()].map(async (slot) => [slot, await loadBrowserIdentity(slotKeys(storage, slot), null)] as const),
    ),
  );
  const calls: { readonly step: string; readonly slot: string }[] = [];
  const slotOf = (identity: BrowserIdentity): string =>
    [...identities].find(([, held]) => held === identity)?.[0] ?? "unknown";
  const deps: RosterDeps = {
    prepare: async (slot) => {
      calls.push({ step: "prepare", slot });
      const store = stores.get(slot);
      if (store === undefined) throw new Error(`no store for ${slot}`);
      return store;
    },
    identity: async (slot) => {
      const identity = identities.get(slot);
      if (identity === undefined) throw new Error(`no identity for ${slot}`);
      return identity;
    },
    talk: async (_member, context) => {
      calls.push({ step: `talk:${context.action}`, slot: slotOf(context.identity) });
      expect(stores.get(slotOf(context.identity))).toBe(context.bundle);
    },
    forget: async (slot) => void calls.push({ step: "forget", slot }),
    bundle: (slot) => stores.get(slot),
    enroll: async () => async () => undefined,
  };
  return { first, second, deps, calls };
}

const target = (hostId: string, keySlot?: string) => ({
  hostId,
  hostName: hostId,
  hostKey: "k",
  directUrl: "",
  ...(keySlot === undefined ? {} : { keySlot }),
});

const open = (hostId: string, keySlot?: string): MemberEntry => ({
  target: target(hostId, keySlot),
  state: { phase: "open", connection: {} as unknown as HcConnection, path: "relay" },
});

describe("roster conversations run as the mesh that listed the machine", () => {
  test("a refresh from a machine of the second mesh uses the second mesh's store and keys", async () => {
    const { second, deps, calls } = await twoMeshes();
    await refreshFrom(open(second.hostIds[0] ?? "", "b"), () => true, deps);
    expect(calls).toEqual([
      { step: "prepare", slot: "b" },
      { step: "talk:refresh", slot: "b" },
    ]);
  });

  test("a paired machine is asked as the default identity, as before", async () => {
    const { first, deps, calls } = await twoMeshes();
    await refreshFrom(open(first.hostIds[0] ?? ""), () => true, deps);
    expect(calls.map((call) => call.slot)).toEqual(["", ""]);
  });

  test("leaving the second mesh speaks as it, through its own machine, and forgets only it", async () => {
    const { first, second, deps, calls } = await twoMeshes();
    const entries = [open(first.hostIds[0] ?? ""), open(second.hostIds[0] ?? "", "b")];
    await leaveMembership("b", entries, deps);
    expect(calls).toEqual([
      { step: "talk:leave", slot: "b" },
      { step: "forget", slot: "b" },
    ]);
  });
});
