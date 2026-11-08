import { base64urlEncode } from "@doriface/crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { admitMembers, removeSides, side } from "../../../host/src/testing/join-harness.ts";
import { memoryStore } from "../storage/idb.ts";
import { type BrowserMembership, MembershipStore, membersOf, reachableTargets } from "./membership.ts";

afterEach(removeSides);

const membership = (meshId: string): BrowserMembership => ({
  meshId,
  records: [{ body: "{}", sig: "x" }],
  signPub: "me",
  inviter: { hostId: "h", hostKey: "k" },
  relayUrl: "wss://relay.example",
  joinedAt: "2026-11-08T00:00:00.000Z",
});

describe("the membership record", () => {
  test("reads back what was adopted", async () => {
    const store = new MembershipStore(memoryStore());
    expect(await store.read()).toBeUndefined();
    expect(await store.adopt(membership("mesh-1"))).toBe(true);
    expect(await store.read()).toEqual(membership("mesh-1"));
  });

  test("a membership of another mesh wins over a later adopt, and the held one is untouched", async () => {
    const store = new MembershipStore(memoryStore());
    await store.adopt(membership("mesh-1"));
    expect(await store.adopt(membership("mesh-2"))).toBe(false);
    expect((await store.read())?.meshId).toBe("mesh-1");
  });

  test("the same mesh may be adopted again: a re-join replaces the bundle", async () => {
    const store = new MembershipStore(memoryStore());
    await store.adopt(membership("mesh-1"));
    const again = { ...membership("mesh-1"), joinedAt: "2026-11-09T00:00:00.000Z" };
    expect(await store.adopt(again)).toBe(true);
    expect((await store.read())?.joinedAt).toBe("2026-11-09T00:00:00.000Z");
  });

  test("a malformed stored value reads as no membership", async () => {
    const storage = memoryStore();
    await storage.put("mesh-membership", { meshId: "mesh-1", records: [{ body: 1 }], signPub: "me" });
    expect(await new MembershipStore(storage).read()).toBeUndefined();
  });
});

describe("the member list a browser derives from its bundle", () => {
  test("is the mesh's view: every machine with its card's hostId and the view's name and key, machines only as targets", () => {
    const a = side("alpha");
    a.mesh.found(a.m.identity, { name: a.m.name, hcId: a.m.hcId });
    admitMembers(a, ["beta", "gamma"]);
    const records = a.mesh.read()?.records ?? [];
    const members = membersOf(records);
    expect(members.map((member) => member.name).toSorted()).toEqual(["alpha", "beta", "gamma"]);
    const alpha = members.find((member) => member.name === "alpha");
    expect(alpha?.hostId).toBe(a.m.identity.hostId);
    expect(alpha?.noisePub).toBe(base64urlEncode(a.m.identity.noise.publicKey));
    expect(members.every((member) => member.kind === "machine")).toBe(true);
    const targets = reachableTargets(members);
    expect(targets.map((target) => target.hostId).toSorted()).toEqual(members.map((m) => m.hostId).toSorted());
    expect(targets.every((target) => target.directUrl === "")).toBe(true);
  });
});
