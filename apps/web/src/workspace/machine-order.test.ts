import { HcRpcError, type JsonObject, type JsonValue } from "@doriface/protocol";
import { type DocCalls, LayoutDoc } from "@doriface/protocol/layout";
import { describe, expect, test } from "bun:test";
import { arrangeMachines, moveMachine, movedOrder, readOrderDocument, storedOrder } from "./machine-order.ts";
import type { MachineEntry } from "./machines.ts";

const machine = (core: string, name = core, local = false): MachineEntry => ({
  id: local ? "local" : `machine:${name}`,
  core,
  name,
  local,
  state: "connected",
  live: 0,
  first: undefined,
});

// The default order, as machineEntries gives it: this machine first, then the added ones by name.
const DEFAULT = [machine("c-studio", "studio", true), machine("c-alpha", "alpha"), machine("c-build", "build")];
const names = (entries: readonly MachineEntry[]): readonly string[] => entries.map((entry) => entry.name);

describe("arrangeMachines", () => {
  test("with no stored order the list is the default order", () => {
    expect(names(arrangeMachines(DEFAULT, null))).toEqual(["studio", "alpha", "build"]);
  });

  test("the stored order is followed, this machine included", () => {
    expect(names(arrangeMachines(DEFAULT, ["c-build", "c-studio", "c-alpha"]))).toEqual(["build", "studio", "alpha"]);
  });

  test("machines the stored order does not name go after the stored ones, in the default order", () => {
    const [studio, alpha, build] = DEFAULT;
    const added = [studio, alpha, machine("c-beta", "beta"), build, machine("c-zeta", "zeta")].flatMap((e) => e ?? []);
    expect(names(arrangeMachines(added, ["c-build", "c-alpha"]))).toEqual(["build", "alpha", "studio", "beta", "zeta"]);
  });

  test("ids of machines that were removed or revoked, and repeated ids, drop out", () => {
    expect(names(arrangeMachines(DEFAULT, ["c-gone", "c-build", "c-build", "c-revoked", "c-alpha"]))).toEqual([
      "build",
      "alpha",
      "studio",
    ]);
  });

  test("the order follows each machine's permanent id, so a renamed machine keeps its place", () => {
    const renamed = [DEFAULT[0], machine("c-alpha", "zz-renamed"), DEFAULT[2]].flatMap((entry) => entry ?? []);
    expect(names(arrangeMachines(renamed, ["c-alpha", "c-build", "c-studio"]))).toEqual([
      "zz-renamed",
      "build",
      "studio",
    ]);
  });

  test("a machine named like another one's old id is not taken for it", () => {
    const lookalike = [DEFAULT[0], machine("c-other", "c-alpha")].flatMap((entry) => entry ?? []);
    expect(names(arrangeMachines(lookalike, ["c-alpha", "c-studio"]))).toEqual(["studio", "c-alpha"]);
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
  test("a document never written reads as empty, and an edit writes the whole list", () => {
    expect(readOrderDocument(null)).toEqual({ kind: "empty" });
    expect(moveMachine(DEFAULT, "c-build", 0)(null)).toEqual({ machine_order: ["c-build", "c-studio", "c-alpha"] });
  });

  test("a document of another shape is read-only, never guessed at", () => {
    expect(readOrderDocument([1])).toEqual({ kind: "unreadable", reason: "an order document that is not an object" });
    for (const order of ["c-a", ["c-a", 3], { 0: "c-a" }]) {
      expect(readOrderDocument({ machine_order: order })).toEqual({
        kind: "unreadable",
        reason: "a machine order that is not a list of machine ids",
      });
    }
  });

  test("an edit keeps every field it does not know byte for byte, in its place", () => {
    const value: JsonObject = { a_newer_field: { kept: [1, "two", null] }, machine_order: ["c-alpha"], z: true };
    const read = readOrderDocument(value);
    if (read.kind !== "ok") throw new Error("not readable");
    const edited = moveMachine(DEFAULT, "c-build", 0)(read.doc);
    expect(JSON.stringify(edited)).toBe(
      JSON.stringify({
        a_newer_field: { kept: [1, "two", null] },
        machine_order: ["c-build", "c-alpha", "c-studio"],
        z: true,
      }),
    );
    expect(edited?.["a_newer_field"]).toBe(value["a_newer_field"]);
  });

  test("a move that changes nothing writes nothing", () => {
    expect(moveMachine(DEFAULT, "c-studio", 0)(null)).toBeNull();
    expect(moveMachine(DEFAULT, "c-gone", 0)(null)).toBeNull();
  });

  test("storedOrder is null until someone moved a machine", () => {
    expect(storedOrder(null)).toBeNull();
    expect(storedOrder({ other: 1 })).toBeNull();
    expect(storedOrder({ machine_order: ["c-a"] })).toEqual(["c-a"]);
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
    const store = coreDoc({ machine_order: ["c-studio", "c-alpha", "c-build"] });
    const doc = new LayoutDoc(store.calls, null, () => undefined, readOrderDocument);
    await doc.refresh();
    store.otherDevice({ machine_order: ["c-alpha", "c-studio", "c-build"], theirs: 1 });
    expect(await doc.edit(moveMachine(DEFAULT, "c-build", 0))).toBe(true);
    expect(store.current()).toEqual({ machine_order: ["c-build", "c-alpha", "c-studio"], theirs: 1 });
  });

  test("a document of another shape is never overwritten", async () => {
    const store = coreDoc({ machine_order: "not a list" });
    const doc = new LayoutDoc(store.calls, null, () => undefined, readOrderDocument);
    await doc.refresh();
    expect(doc.state.phase).toBe("unreadable");
    expect(await doc.edit(moveMachine(DEFAULT, "c-build", 0))).toBe(false);
    expect(store.current()).toEqual({ machine_order: "not a list" });
  });
});
