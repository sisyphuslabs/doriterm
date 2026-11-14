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

function cores(initial: Readonly<Record<string, JsonValue>>) {
  const docs = new Map(Object.entries(initial).map(([on, value]) => [on, { value, version: 1 }]));
  const calls: DocCalls = {
    get: async (on) => docs.get(key(on)) ?? { value: null, version: 0 },
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
  shared.sync(new Set<string | null>([null, "box"]), false);
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
});
