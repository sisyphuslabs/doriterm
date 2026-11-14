import { describe, expect, test } from "bun:test";
import { HcRpcError, type JsonObject, type JsonValue } from "@doriface/protocol";
import {
  type DocCalls,
  type DocState,
  moveInOrder,
  orderRank,
  stampOrder,
  storedOrder,
} from "@doriface/protocol/layout";
import { SharedOrder } from "./shared-order.ts";

/** One `doriface` document per core, as hc keeps them: a version each, and a write at an old version refused. */
const key = (on: string | null): string => on ?? "routing";

function cores(initial: Readonly<Record<string, JsonValue>>, failing: Set<string> = new Set()) {
  const docs = new Map(Object.entries(initial).map(([on, value]) => [on, { value, version: 1 }]));
  const calls: DocCalls = {
    get: async (on) => {
      if (failing.has(key(on))) throw new Error("doc.get failed");
      return docs.get(key(on)) ?? { value: null, version: 0 };
    },
    set: async (on, value, version) => {
      const held = docs.get(key(on)) ?? { value: null, version: 0 };
      if (held.version !== version)
        throw new HcRpcError({ code: -32000, message: "conflict", data: { kind: "conflict" } });
      docs.set(key(on), { value, version: version + 1 });
      return { version: version + 1 };
    },
  };
  const order = (on: string): readonly string[] | null => {
    const value = docs.get(on)?.value;
    return storedOrder(
      typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : null,
    );
  };
  const doc = (on: string): JsonObject | null => {
    const value = docs.get(on)?.value;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
  };
  /** Another device's write, straight to one core. */
  const write = (on: string, value: JsonValue): void => {
    const held = docs.get(on) ?? { value: null, version: 0 };
    docs.set(on, { value, version: held.version + 1 });
  };
  return { calls, order, doc, write };
}

/**
 * Resolves once every read and write the order started has settled: the fake cores answer on the microtask queue only,
 * so draining it is enough, with no timer.
 */
const settled = async (): Promise<void> => {
  // oxlint-disable-next-line no-await-in-loop -- each turn lets the next queued read or write run
  for (let turn = 0; turn < 500; turn += 1) await Promise.resolve();
};

const ordered = (state: DocState): readonly string[] | null =>
  state.phase === "ready" ? storedOrder(state.doc) : null;

let clock = 1_000;
const open = (calls: DocCalls, device = "d1") => {
  const shared = new SharedOrder(
    calls,
    () => undefined,
    device,
    () => (clock += 1),
  );
  shared.sync(new Set<string | null>([null, "box"]), false, true);
  return shared;
};

const LIVE = ["routing", "box"];

describe("the shared machine order, read from every core as one (#2531)", () => {
  test("the copy holding the latest write is the order, whichever core holds it, and the core behind is brought up", async () => {
    const newer = stampOrder({ machine_order: ["box", "routing"] }, { n: 2, at: 5, by: "d2" });
    const older = stampOrder({ machine_order: ["routing", "box"] }, { n: 1, at: 9, by: "d1" });
    const held = cores({ routing: older, box: newer });
    const shared = open(held.calls);
    await settled();
    expect(ordered(shared.state)).toEqual(["box", "routing"]);
    expect(held.order("routing")).toEqual(["box", "routing"]);
    expect(orderRank(held.doc("routing"))).toEqual({ n: 2, at: 5, by: "d2" });
  });

  test("orders kept per core before the order was shared become one, the routing core's first, stamped on every core", async () => {
    const held = cores({ routing: { machine_order: ["box", "routing"] }, box: { machine_order: ["routing", "box"] } });
    const shared = open(held.calls);
    await settled();
    expect(ordered(shared.state)).toEqual(["box", "routing"]);
    expect(held.order("box")).toEqual(["box", "routing"]);
    expect(orderRank(held.doc("box"))).not.toBeNull();
    expect(orderRank(held.doc("routing"))).toEqual(orderRank(held.doc("box")));
  });

  test("with no order on any core nothing is written", async () => {
    const held = cores({});
    const shared = open(held.calls);
    await settled();
    expect(ordered(shared.state)).toBeNull();
    expect(held.doc("routing")).toBeNull();
    expect(held.doc("box")).toBeNull();
  });

  test("a move is one stamped write on every core, counted one past the order it was made on", async () => {
    const held = cores({});
    const shared = open(held.calls);
    await settled();
    expect(await shared.edit(moveInOrder(LIVE, "box", 0))).toBe(true);
    await settled();
    expect(held.order("routing")).toEqual(["box", "routing"]);
    expect(held.order("box")).toEqual(["box", "routing"]);
    expect(orderRank(held.doc("routing"))?.n).toBe(1);
    expect(ordered(shared.state)).toEqual(["box", "routing"]);
  });

  test("a core another device moved since this one read it gets this move made again on its order, so both moves stay", async () => {
    const three = ["routing", "box", "lab"];
    const held = cores({});
    const shared = open(held.calls);
    await settled();
    // The other device moved lab to the top on the routing core, after this device last read it.
    held.write("routing", stampOrder({ machine_order: ["lab", "routing", "box"] }, { n: 1, at: 50, by: "d2" }));
    expect(await shared.edit(moveInOrder(three, "box", 0))).toBe(true);
    await settled();
    expect(held.order("routing")).toEqual(["box", "lab", "routing"]);
  });

  test("a core whose copy cannot be read refuses a move instead of being written over on a guess", async () => {
    const held = cores({ routing: { machine_order: "not a list" } });
    const shared = open(held.calls);
    await settled();
    await expect(shared.edit(moveInOrder(LIVE, "box", 0))).rejects.toThrow("not a list of machine ids");
    expect(held.order("box")).toBeNull();
  });

  test("before machine.list answers, the routing core's order alone is not merged and written over the others (#2534 review)", async () => {
    const held = cores({
      routing: { machine_order: ["routing", "box"] },
      box: { machine_order: ["lab", "box", "routing"] },
    });
    const shared = new SharedOrder(
      held.calls,
      () => undefined,
      "d1",
      () => (clock += 1),
    );
    shared.sync(new Set<string | null>([null]), false);
    await settled();
    expect(orderRank(held.doc("routing"))).toBeNull();
    shared.sync(new Set<string | null>([null, "box"]), false, true);
    await settled();
    expect(ordered(shared.state)).toEqual(["routing", "box", "lab"]);
    expect(held.order("box")).toEqual(["routing", "box", "lab"]);
  });

  test("a copy whose read failed holds the one-time merge back until it is read, so its order is merged, not overwritten (#2534 review)", async () => {
    const failing = new Set(["box"]);
    const held = cores(
      { routing: { machine_order: ["routing", "box"] }, box: { machine_order: ["lab", "box", "routing"] } },
      failing,
    );
    const shared = open(held.calls);
    await settled();
    expect(orderRank(held.doc("routing"))).toBeNull();
    failing.delete("box");
    shared.sync(new Set<string | null>([null, "box"]), true, true);
    await settled();
    expect(held.order("box")).toEqual(["routing", "box", "lab"]);
    expect(held.order("routing")).toEqual(["routing", "box", "lab"]);
  });

  test("before the first stamped write, a move waits for a copy whose read failed instead of stamping an order without it (#2534 review)", async () => {
    const failing = new Set(["box"]);
    const held = cores(
      { routing: { machine_order: ["routing", "box"] }, box: { machine_order: ["lab", "box", "routing"] } },
      failing,
    );
    const shared = open(held.calls);
    await settled();
    await expect(shared.edit(moveInOrder(LIVE, "box", 0))).rejects.toThrow("doc.get failed");
    expect(orderRank(held.doc("routing"))).toBeNull();
    failing.delete("box");
    shared.sync(new Set<string | null>([null, "box"]), true, true);
    await settled();
    expect(held.order("box")).toEqual(["routing", "box", "lab"]);
  });

  test("an older client's second move holds: the copy it moved is stamped afresh, so the next move ranks above every copy (#2534 review)", async () => {
    const base = stampOrder({ machine_order: ["routing", "box", "lab"] }, { n: 1, at: 1, by: "d2" });
    const held = cores({ routing: base, box: base });
    open(held.calls);
    await settled();
    held.write("routing", { ...base, machine_order: ["box", "routing", "lab"] });
    const shared = open(held.calls);
    await settled();
    expect(held.order("box")).toEqual(["box", "routing", "lab"]);
    const second = held.doc("routing") ?? {};
    held.write("routing", { ...second, machine_order: ["box", "lab", "routing"] });
    shared.sync(new Set<string | null>([null, "box"]), true, true);
    await settled();
    expect(held.order("routing")).toEqual(["box", "lab", "routing"]);
    expect(held.order("box")).toEqual(["box", "lab", "routing"]);
  });

  test("a machine offline at the one-time merge has its own order merged in when it joins, not overwritten (#2534 review)", async () => {
    const held = cores({ routing: { machine_order: ["routing", "box"] }, box: { machine_order: ["box", "routing"] } });
    const shared = open(held.calls);
    await settled();
    held.write("lab", { machine_order: ["lab", "box", "routing"] });
    shared.sync(new Set<string | null>([null, "box", "lab"]), false, true);
    await settled();
    expect(held.order("lab")).toEqual(["routing", "box", "lab"]);
    expect(held.order("routing")).toEqual(["routing", "box", "lab"]);
  });

  test("bring-up never writes over a copy that changed after it was read: an older client's later move is read and kept (#2534 review)", async () => {
    const base = stampOrder({ machine_order: ["routing", "box", "lab"] }, { n: 1, at: 1, by: "d2" });
    const held = cores({ routing: { ...base, machine_order: ["box", "routing", "lab"] }, box: base });
    // The older client's second move lands on the routing core between this device's read and its bring-up write.
    let raced = false;
    const calls: DocCalls = {
      get: held.calls.get,
      set: async (on, value, version) => {
        if (!raced && on === null) {
          raced = true;
          held.write("routing", { ...base, machine_order: ["box", "lab", "routing"] });
        }
        return held.calls.set(on, value, version);
      },
    };
    const shared = open(calls);
    await settled();
    expect(raced).toBe(true);
    expect(held.order("routing")).toEqual(["box", "lab", "routing"]);
    shared.sync(new Set<string | null>([null, "box"]), true, true);
    await settled();
    expect(held.order("routing")).toEqual(["box", "lab", "routing"]);
    expect(held.order("box")).toEqual(["box", "lab", "routing"]);
  });
});
