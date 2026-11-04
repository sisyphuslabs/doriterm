import { describe, expect, test } from "bun:test";
import type { JsonObject, JsonValue } from "../json.ts";
import { HcRpcError } from "../jsonrpc.ts";
import { arrangeIds, moveInOrder, movedOrder, readOrderDocument, storedOrder } from "./order.ts";
import { type DocCalls, LayoutDoc } from "./sync.ts";

// The live ids in the default order: this machine, then the added ones by name.
const LIVE = ["studio", "alpha", "build"];

describe("arrangeIds", () => {
  test("with no stored order the ids stay in the default order", () => {
    expect(arrangeIds(LIVE, null)).toEqual(["studio", "alpha", "build"]);
  });

  test("the stored order is followed, this machine included", () => {
    expect(arrangeIds(LIVE, ["build", "studio", "alpha"])).toEqual(["build", "studio", "alpha"]);
  });

  test("ids the stored order does not name go after the stored ones, in the default order", () => {
    expect(arrangeIds(["studio", "alpha", "beta", "build", "zeta"], ["build", "alpha"])).toEqual([
      "build",
      "alpha",
      "studio",
      "beta",
      "zeta",
    ]);
  });

  test("ids of machines that were removed or revoked, and repeated ids, drop out", () => {
    expect(arrangeIds(LIVE, ["gone", "build", "build", "revoked", "alpha"])).toEqual(["build", "alpha", "studio"]);
  });
});

describe("movedOrder", () => {
  const ids = ["a", "b", "c", "d"];
  test("moves an id up, down and across the list", () => {
    expect(movedOrder(ids, "c", 1)).toEqual(["a", "c", "b", "d"]);
    expect(movedOrder(ids, "b", 2)).toEqual(["a", "c", "b", "d"]);
    expect(movedOrder(ids, "d", 0)).toEqual(["d", "a", "b", "c"]);
    expect(movedOrder(ids, "a", 3)).toEqual(["b", "c", "d", "a"]);
  });

  test("an index past either end lands at that end", () => {
    expect(movedOrder(ids, "b", -4)).toEqual(["b", "a", "c", "d"]);
    expect(movedOrder(ids, "b", 9)).toEqual(["a", "c", "d", "b"]);
  });

  test("an id not in the list, or a move to its own place, is no move", () => {
    expect(movedOrder(ids, "x", 0)).toBeNull();
    expect(movedOrder(ids, "c", 2)).toBeNull();
    expect(movedOrder(ids, "a", -1)).toBeNull();
  });
});

describe("the order document", () => {
  test("a document never written reads as empty, and a move writes the whole list", () => {
    expect(readOrderDocument(null)).toEqual({ kind: "empty" });
    expect(moveInOrder(LIVE, "build", 0)(null)).toEqual({ machine_order: ["build", "studio", "alpha"] });
  });

  test("a document of another shape is read-only, never guessed at", () => {
    expect(readOrderDocument([1])).toEqual({ kind: "unreadable", reason: "an order document that is not an object" });
    for (const order of ["a", ["a", 3], { 0: "a" }]) {
      expect(readOrderDocument({ machine_order: order })).toEqual({
        kind: "unreadable",
        reason: "a machine order that is not a list of machine ids",
      });
    }
  });

  test("a move keeps every field it does not know byte for byte, in its place", () => {
    const value: JsonObject = { a_newer_field: { kept: [1, "two", null] }, machine_order: ["alpha"], z: true };
    const read = readOrderDocument(value);
    if (read.kind !== "ok") throw new Error("not readable");
    const edited = moveInOrder(LIVE, "build", 0)(read.doc);
    expect(JSON.stringify(edited)).toBe(
      JSON.stringify({
        a_newer_field: { kept: [1, "two", null] },
        machine_order: ["build", "alpha", "studio"],
        z: true,
      }),
    );
    expect(edited?.["a_newer_field"]).toBe(value["a_newer_field"]);
  });

  test("a move that changes nothing writes nothing", () => {
    expect(moveInOrder(LIVE, "studio", 0)(null)).toBeNull();
    expect(moveInOrder(LIVE, "gone", 0)(null)).toBeNull();
  });

  test("storedOrder is null until someone moved a machine", () => {
    expect(storedOrder(null)).toBeNull();
    expect(storedOrder({ other: 1 })).toBeNull();
    expect(storedOrder({ machine_order: ["a"] })).toEqual(["a"]);
  });
});

/** A core document with compare-and-set, where "another device" can write between our read and our write. */
function coreDoc(initial: JsonValue) {
  let value = initial;
  let version = initial === null ? 0 : 1;
  let before: (() => void) | undefined;
  const calls: DocCalls = {
    get: async () => ({ value, version }),
    set: async (_on, next, at) => {
      before?.();
      before = undefined;
      if (at !== version) throw new HcRpcError({ code: -32000, message: "conflict", data: { kind: "conflict" } });
      value = next;
      version += 1;
      return { version };
    },
  };
  const otherDevice = (next: JsonValue): void => {
    before = () => {
      value = next;
      version += 1;
    };
  };
  return { calls, current: () => value, otherDevice };
}

describe("a move saved through the order document", () => {
  test("after another device's write is refused it moves the machine again on that device's order", async () => {
    const store = coreDoc({ machine_order: ["studio", "alpha", "build"] });
    const doc = new LayoutDoc(store.calls, null, () => undefined, readOrderDocument);
    await doc.refresh();
    store.otherDevice({ machine_order: ["alpha", "studio", "build"], theirs: 1 });
    expect(await doc.edit(moveInOrder(LIVE, "build", 0))).toBe(true);
    expect(store.current()).toEqual({ machine_order: ["build", "alpha", "studio"], theirs: 1 });
  });

  test("a document of another shape is never overwritten", async () => {
    const store = coreDoc({ machine_order: "not a list" });
    const doc = new LayoutDoc(store.calls, null, () => undefined, readOrderDocument);
    await doc.refresh();
    expect(doc.state.phase).toBe("unreadable");
    expect(await doc.edit(moveInOrder(LIVE, "build", 0))).toBe(false);
    expect(store.current()).toEqual({ machine_order: "not a list" });
  });
});
