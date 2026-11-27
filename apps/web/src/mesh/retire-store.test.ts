import { describe, expect, test } from "bun:test";
import { memoryStore } from "../storage/idb.ts";
import { beginRetire, claimExact } from "./enrollment.ts";
import { DEFAULT_SLOT } from "./identity-slots.ts";
import { joinedStore, meshFixture } from "./mesh-fixture.test-support.ts";
import { dropsStore } from "./membership-lifecycle.ts";

describe("which retirements drop the slot's store from the page (relay e2e on #2890)", () => {
  test("a roster refresh's join abandoned on the empty default slot keeps the store and its refresh bound", async () => {
    const storage = memoryStore();
    const join = await claimExact(storage, DEFAULT_SLOT, "roster-refresh");
    if (join === undefined) throw new Error("the default slot was not free");
    const claim = await beginRetire(storage, DEFAULT_SLOT, { generation: join.generation, claimOnly: true });
    expect(claim?.joined).toBe(false);
    expect(dropsStore(DEFAULT_SLOT, claim)).toBe(false);
  });

  test("leaving a mesh, or dropping a join on its own slot, drops the store", async () => {
    const storage = memoryStore();
    await joinedStore(storage, meshFixture(), DEFAULT_SLOT);
    expect(dropsStore(DEFAULT_SLOT, await beginRetire(storage, DEFAULT_SLOT))).toBe(true);
    const join = await claimExact(storage, "second", "tab");
    if (join === undefined) throw new Error("the slot was not free");
    const claim = await beginRetire(storage, "second", { generation: join.generation, claimOnly: true });
    expect(dropsStore("second", claim)).toBe(true);
  });
});
