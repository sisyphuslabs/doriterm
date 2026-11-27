import { generateHostIdentity } from "@doriface/crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { type KeyValueStore, memoryStore } from "../storage/idb.ts";
import { beginRetire, finishRetire } from "./enrollment.ts";
import { resetBrowserIdentity } from "./identity.ts";
import { DEFAULT_SLOT, slotKeys } from "./identity-slots.ts";
import { joinedStore, meshFixture } from "./mesh-fixture.test-support.ts";
import { dropAll, membershipBundle, prepareMembership } from "./membership-state.ts";

afterEach(dropAll);

/** Two tabs over one IndexedDB: each its own storage object, so its own key views and caches. */
function twoTabs(): { readonly here: KeyValueStore; readonly other: KeyValueStore } {
  const backing = memoryStore();
  const tab = (): KeyValueStore => ({ get: (key) => backing.get(key), put: (key, value) => backing.put(key, value) });
  return { here: tab(), other: tab() };
}

describe("a kept empty default store follows a default-key reset made in another tab (review of #2890)", () => {
  test("after the other tab's last leave resets the default keys, this tab takes in a roster that admits the new ones", async () => {
    const { here, other } = twoTabs();
    const stale = await prepareMembership(DEFAULT_SLOT, here);
    expect(stale.snapshot().phase).toBe("empty");

    // The other tab leaves its last mesh, on another slot: the browser is a stranger again, with new default keys.
    await joinedStore(other, meshFixture(), "second");
    const left = await beginRetire(other, "second");
    if (left?.last !== true) throw new Error("the other tab's leave was not its last mesh");
    await finishRetire(other, left, () => resetBrowserIdentity(slotKeys(other, DEFAULT_SLOT)));
    const fresh = generateHostIdentity();
    await other.put("mesh-sign-key", { kind: "raw", privateKey: fresh.sign.secretKey });
    await other.put("device-key", { kind: "raw", privateKey: fresh.noise.secretKey });

    const bundle = await prepareMembership(DEFAULT_SLOT, here);
    await bundle.enroll();
    const mesh = meshFixture(["studio"], "my-browser", fresh);
    expect(await bundle.adopt(mesh.membership)).toBe(true);
    expect(bundle.snapshot().phase).toBe("joined");
    expect(bundle.keys).toEqual(mesh.keys);
  });

  test("two callers at once after the reset get the same store the page holds, and a commit through it shows there", async () => {
    const { here, other } = twoTabs();
    await prepareMembership(DEFAULT_SLOT, here);
    await resetBrowserIdentity(slotKeys(other, DEFAULT_SLOT));
    const fresh = generateHostIdentity();
    await other.put("mesh-sign-key", { kind: "raw", privateKey: fresh.sign.secretKey });
    await other.put("device-key", { kind: "raw", privateKey: fresh.noise.secretKey });

    const [first, second] = await Promise.all([
      prepareMembership(DEFAULT_SLOT, here),
      prepareMembership(DEFAULT_SLOT, here),
    ]);
    expect(second).toBe(first);
    expect(membershipBundle(DEFAULT_SLOT)).toBe(first);
    await first.enroll();
    expect(await first.adopt(meshFixture(["studio"], "my-browser", fresh).membership)).toBe(true);
    expect(membershipBundle(DEFAULT_SLOT)?.snapshot().phase).toBe("joined");
  });

  test("while the default keys are unchanged, the same store is handed out again, refresh bound and all", async () => {
    const { here } = twoTabs();
    const first = await prepareMembership(DEFAULT_SLOT, here);
    expect(await prepareMembership(DEFAULT_SLOT, here)).toBe(first);
  });
});
