import type { EventFeed, HcConnection } from "@doriface/client";
import { generateX25519 } from "@doriface/crypto";
import { type HcEvent, HcRpcError, isJsonObject, type JsonObject, type JsonValue } from "@doriface/protocol";
import {
  type DocCalls,
  LAYOUT_DOC,
  LayoutDoc,
  moveInOrder,
  ORDER_DOC,
  readOrderDocument,
} from "@doriface/protocol/layout";
import { afterAll, describe, expect, test } from "bun:test";
import { type RelayedHost, startRelayedHost } from "./support/relayed-host.ts";
import { setUpOnce } from "./support/set-up-once.ts";
import { Matches } from "./support/watch.ts";

// The machine ids in the default order both devices see: this machine, then the added ones by name.
const MACHINES = ["studio", "alpha", "build", "lab"];

/** Fields a newer doriface could keep in the same document, at the top and nested; never touched by a move. */
const FUTURE: JsonObject = { "x-future": { kept: [1, "two", null], nested: { deep: true } }, pinned: ["lab"] };

interface Device {
  readonly hc: HcConnection;
  readonly feed: EventFeed;
  readonly docs: Matches<HcEvent>;
  readonly conflicts: () => number;
  readonly order: LayoutDoc;
}

let relayed: RelayedHost | undefined;
const devices: Device[] = [];

/** The web app's order sync over one relayed connection, counting the writes the core refused as conflicts. */
async function device(name: string): Promise<Device> {
  if (relayed === undefined) throw new Error("setup failed");
  const key = generateX25519();
  await relayed.pair(key, name);
  const hc = await relayed.connect(key);
  const feed = await hc.subscribe();
  let conflicts = 0;
  const calls: DocCalls = {
    get: () => hc.call("doc.get", { name: ORDER_DOC }),
    set: (_on, value, version) =>
      hc.call("doc.set", { name: ORDER_DOC, value, version }).catch((cause: unknown) => {
        if (cause instanceof HcRpcError && cause.kind === "conflict") conflicts += 1;
        throw cause;
      }),
  };
  const order = new LayoutDoc(calls, null, () => undefined, readOrderDocument);
  await order.refresh();
  const docs = new Matches<HcEvent>();
  feed.onEvent((event) => {
    if (event.type === "doc") docs.push(event);
  });
  return { hc, feed, docs, conflicts: () => conflicts, order };
}

setUpOnce(async () => {
  relayed = await startRelayedHost("relay-order");
  devices.push(await device("laptop"), await device("phone"));
}, 120_000);

afterAll(async () => {
  for (const { feed, hc } of devices) {
    feed.close();
    hc.close();
  }
  await relayed?.stop();
});

const both = (): readonly [Device, Device] => {
  const [a, b] = devices;
  if (a === undefined || b === undefined) throw new Error("setup failed");
  return [a, b];
};

const stored = async (from: Device): Promise<JsonValue> => (await from.hc.call("doc.get", { name: ORDER_DOC })).value;

/** Both devices start from the same document: the future fields and `order`. */
async function startFrom(a: Device, b: Device, order: readonly string[]): Promise<void> {
  expect(await a.order.edit(() => ({ ...FUTURE, machine_order: [...order] }))).toBe(true);
  await b.order.refresh();
}

describe("the machine order, two devices through the relay", () => {
  test("an order one device writes reaches the other live, by the core's doc event through the relay", async () => {
    const [a, b] = both();
    await startFrom(a, b, ["studio", "alpha", "build", "lab"]);
    expect(await a.order.edit(moveInOrder(MACHINES, "lab", 0))).toBe(true);
    const wrote = a.order.state.phase === "ready" ? a.order.state.version : -1;
    const heard = await b.docs.next(
      (event) => event.type === "doc" && event.data.name === ORDER_DOC && event.data.version === wrote,
      `the doc event for version ${wrote}`,
    );
    if (heard.type !== "doc") throw new Error("not a doc event");
    await b.order.heard(heard.data.version);
    const state = b.order.state;
    expect(state.phase === "ready" ? state.doc?.["machine_order"] : null).toEqual(["lab", "studio", "alpha", "build"]);
  }, 60_000);

  test("a refused compare-and-set moves the machine again on the other device's order, so both moves stay", async () => {
    const [a, b] = both();
    await startFrom(a, b, ["studio", "alpha", "build", "lab"]);
    const before = b.conflicts();
    // b has not read a's write: its compare-and-set is refused, so it re-reads and moves `alpha` on a's order.
    expect(await a.order.edit(moveInOrder(MACHINES, "lab", 0))).toBe(true);
    expect(await b.order.edit(moveInOrder(MACHINES, "alpha", 0))).toBe(true);
    expect(b.conflicts()).toBeGreaterThan(before);
    expect(await stored(a)).toMatchObject({ machine_order: ["alpha", "lab", "studio", "build"] });
  }, 60_000);

  test("two devices moving at once both land, and fields the order does not know come back unchanged", async () => {
    const [a, b] = both();
    await startFrom(a, b, ["studio", "alpha", "build", "lab"]);
    const before = a.conflicts() + b.conflicts();
    const moves = await Promise.all([
      a.order.edit(moveInOrder(MACHINES, "alpha", 3)),
      b.order.edit(moveInOrder(MACHINES, "studio", 2)),
    ]);
    expect(moves).toEqual([true, true]);
    expect(a.conflicts() + b.conflicts()).toBeGreaterThan(before);
    const value = await stored(b);
    if (!isJsonObject(value)) throw new Error("no document");
    const { machine_order: order, ...rest } = value;
    // The core stores a document's keys in its own (sorted) order, so the fields are compared by value, not by key order.
    expect(rest).toStrictEqual(FUTURE);
    if (!Array.isArray(order)) throw new Error("no machine order");
    // Whichever write lands first, the second is made again on it: alpha ends last, studio two from wherever it was.
    expect([
      ["build", "lab", "studio", "alpha"],
      ["build", "studio", "lab", "alpha"],
    ]).toContainEqual(order.map(String));
  }, 60_000);

  test("moving machines never writes the herdr-app layout document", async () => {
    const [a, b] = both();
    const layout = await a.hc.call("doc.get", { name: LAYOUT_DOC });
    await startFrom(a, b, ["studio", "alpha", "build", "lab"]);
    expect(await a.order.edit(moveInOrder(MACHINES, "build", 0))).toBe(true);
    expect(await a.hc.call("doc.get", { name: LAYOUT_DOC })).toEqual(layout);
  }, 60_000);
});
