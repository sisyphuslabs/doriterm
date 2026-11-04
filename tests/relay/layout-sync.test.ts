import type { EventFeed, HcConnection } from "@doriface/client";
import { generateX25519 } from "@doriface/crypto";
import { HcRpcError, isJsonObject, parseJson, type JsonObject, type JsonValue } from "@doriface/protocol";
import {
  editTab,
  LAYOUT_DOC,
  LayoutDoc,
  splitPane,
  tabsOf,
  terminalBlock,
  type DocCalls,
} from "@doriface/protocol/layout";
import { afterAll, describe, expect, test } from "bun:test";
import { type RelayedHost, startRelayedHost } from "./support/relayed-host.ts";
import { setUpOnce } from "./support/set-up-once.ts";
import { type EventWatch, watchEvents } from "./support/watch.ts";

const DEEP_TAB = "tbff1e9c7fe9d99f6cd247be825a5da61a";
const DEEPEST = "p986c8fa4187d4d895e540c2850573fac";
const OTHER_TAB = "tb75ab417b08a576fc183e9e363e046aab";
const OTHER_PANE = "pa1ac18cbd58508cb4e5871c0f7741528";

/** Keys in code-point order at every level, the order herdr-app writes them in, so a byte comparison is fair. */
function sorted(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sorted);
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, sorted(value[key] ?? null)]),
  );
}

function* nodesOf(node: JsonValue): Generator<JsonObject> {
  if (!isJsonObject(node)) return;
  yield node;
  const children = node["children"];
  if (Array.isArray(children)) for (const child of children) yield* nodesOf(child);
}

const nodeById = (root: JsonValue, id: string): JsonObject | undefined =>
  [...nodesOf(root)].find((node) => node["id"] === id);

const tabById = (doc: JsonValue, id: string): JsonObject | undefined => {
  if (!isJsonObject(doc) || !Array.isArray(doc["spaces"])) return undefined;
  for (const space of doc["spaces"]) {
    if (!isJsonObject(space) || !Array.isArray(space["tabs"])) continue;
    const tab = space["tabs"].find((each) => isJsonObject(each) && each["id"] === id);
    if (isJsonObject(tab)) return tab;
  }
  return undefined;
};

function rebuilt(value: JsonValue, change: (node: JsonObject) => JsonObject): JsonValue {
  if (Array.isArray(value)) return value.map((each) => rebuilt(each, change));
  if (!isJsonObject(value)) return value;
  const inner = Object.fromEntries(Object.entries(value).map(([key, each]) => [key, rebuilt(each, change)]));
  return change(inner);
}

const FUTURE_TAB_FIELDS: Readonly<Record<string, JsonValue>> = {
  [DEEP_TAB]: { pinned: 3 },
  [OTHER_TAB]: "other tab field",
};

const isTab = (node: JsonObject): boolean => "root" in node;

function withFutureFields(read: JsonValue): JsonObject {
  const tagged = rebuilt(read, (node) => {
    const id = typeof node["id"] === "string" ? node["id"] : "";
    const tabField = isTab(node) ? FUTURE_TAB_FIELDS[id] : undefined;
    if (tabField !== undefined) return { ...node, "x-future-tab": tabField };
    if (node["type"] === "block" && id === DEEPEST)
      return { ...node, "x-future-pane": { marks: ["a", "b"], scrollback: 1200 } };
    return Array.isArray(node["tabs"]) ? { ...node, "x-future-space": "space field" } : node;
  });
  if (!isJsonObject(tagged)) throw new Error("unexpected fixture");
  const out = sorted({ ...tagged, "x-future-doc": { kept: [1, "two", null], nested: { deep: true } } });
  const text = JSON.stringify(out);
  for (const key of ["x-future-doc", "x-future-space", "x-future-pane"]) {
    if (text.split(`"${key}"`).length !== 2) throw new Error(`the fixture must carry ${key} once`);
  }
  if (text.split('"x-future-tab"').length !== 3 || !isJsonObject(out)) throw new Error("unexpected fixture");
  return out;
}

/**
 * A document herdr-app 0.1.12 wrote (two tabs, one split four levels deep, the other beside a herdr-app panel), plus
 * fields doriface knows nothing about at every level a newer herdr-app could add them: the document, a space, a tab
 * and a pane. Built by plain JSON edits here, never through the layout module under test.
 */
const FIXTURE: JsonObject = withFutureFields(
  parseJson(
    await Bun.file(
      new URL("../../packages/protocol/src/layout/fixtures/herdr-app-0.1.12.json", import.meta.url),
    ).text(),
  ),
);

const outsideTrees = (doc: JsonValue, tabs: readonly string[]): string =>
  JSON.stringify(
    rebuilt(doc, (node) =>
      isTab(node) && typeof node["id"] === "string" && tabs.includes(node["id"]) ? { ...node, root: null } : node,
    ),
  );

/** A split moves or halves its target's size and nothing else, so every other pane of the tree comes back as written. */
function untouchedNodes(
  doc: JsonValue,
  tab: string,
): readonly { readonly id: string; readonly before: string; readonly after: string }[] {
  const before = tabById(FIXTURE, tab)?.["root"] ?? null;
  const after = tabById(doc, tab)?.["root"] ?? null;
  return [...nodesOf(before)]
    .filter((node) => node["type"] === "block" && node["id"] !== DEEPEST && node["id"] !== OTHER_PANE)
    .map((node) => {
      const id = String(node["id"]);
      return { id, before: JSON.stringify(node), after: JSON.stringify(nodeById(after, id) ?? null) };
    });
}

const sizeless = (node: JsonObject | undefined): string =>
  JSON.stringify(Object.entries(node ?? {}).filter(([key]) => key !== "size"));

interface Device {
  readonly hc: HcConnection;
  readonly feed: EventFeed;
  readonly events: EventWatch;
  readonly conflicts: () => number;
  readonly layout: LayoutDoc;
}

let relayed: RelayedHost | undefined;
const devices: Device[] = [];

/** The web app's own sync over one relayed connection, counting the writes the core refused as conflicts. */
async function device(name: string): Promise<Device> {
  if (relayed === undefined) throw new Error("setup failed");
  const key = generateX25519();
  await relayed.pair(key, name);
  const hc = await relayed.connect(key);
  const feed = await hc.subscribe();
  let conflicts = 0;
  const calls: DocCalls = {
    get: (on) => hc.call("doc.get", on === null ? { name: LAYOUT_DOC } : { name: LAYOUT_DOC, on }),
    set: (on, value, version) =>
      hc.call("doc.set", on === null ? { name: LAYOUT_DOC, value, version } : { name: LAYOUT_DOC, on, value, version }),
  };
  const counted: DocCalls = {
    get: calls.get,
    set: (on, value, version) =>
      calls.set(on, value, version).catch((cause: unknown) => {
        if (cause instanceof HcRpcError && cause.kind === "conflict") conflicts += 1;
        throw cause;
      }),
  };
  const layout = new LayoutDoc(counted, null, () => undefined);
  await layout.refresh();
  return { hc, feed, events: watchEvents(feed), conflicts: () => conflicts, layout };
}

setUpOnce(async () => {
  relayed = await startRelayedHost("relay-layout");
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

const splitIn = (tab: string, target: string, pane: string) => (doc: JsonObject | null) =>
  doc === null
    ? null
    : editTab(doc, tab, (root) => splitPane(root, target, "row", terminalBlock(pane, "t9"), `s-${pane}`));

function panesIn(value: JsonValue, tab: string): readonly string[] {
  if (!isJsonObject(value)) return [];
  const found = tabsOf(value).find((each) => each.id === tab);
  return found === undefined
    ? []
    : [...nodesOf(found.root)].filter((n) => n["type"] === "block").map((n) => String(n["id"]));
}

async function startFrom(a: Device, b: Device): Promise<void> {
  expect(await a.layout.edit(() => FIXTURE)).toBe(true);
  await b.layout.refresh();
}

describe("the herdr-app layout document, two devices through the relay", () => {
  test("a tree one device writes reaches the other live, by the core's doc event through the relay", async () => {
    const [a, b] = both();
    expect(await a.layout.edit(() => FIXTURE)).toBe(true);
    const heard = await b.events.next("doc");
    expect(heard.data).toMatchObject({ name: LAYOUT_DOC });
    if (heard.type !== "doc") throw new Error("not a doc event");
    await b.layout.heard(heard.data.version);
    const state = b.layout.state;
    expect(JSON.stringify(state.phase === "ready" ? state.doc : null)).toBe(JSON.stringify(FIXTURE));
  }, 60_000);

  test("a refused compare-and-set re-reads and makes its edit again: both devices' splits of different tabs stay", async () => {
    const [a, b] = both();
    await startFrom(a, b);
    // b has not read a's next write: its compare-and-set is refused, so it re-reads and splits again on a's document.
    const conflictsBefore = b.conflicts();
    const written = await a.layout.edit(splitIn(DEEP_TAB, DEEPEST, "p-from-laptop"));
    const raced = await b.layout.edit(splitIn(OTHER_TAB, OTHER_PANE, "p-from-phone"));
    expect([written, raced]).toEqual([true, true]);
    expect(b.conflicts()).toBeGreaterThan(conflictsBefore);
    const { value } = await a.hc.call("doc.get", { name: LAYOUT_DOC });
    expect(panesIn(value, DEEP_TAB)).toContain("p-from-laptop");
    expect(panesIn(value, OTHER_TAB)).toContain("p-from-phone");
  }, 60_000);

  test("herdr-app's fields, known or not, come back byte for byte after both devices edited inside two trees", async () => {
    const [a, b] = both();
    await startFrom(a, b);
    expect(await a.layout.edit(splitIn(DEEP_TAB, DEEPEST, "p-keep-a"))).toBe(true);
    expect(await b.layout.edit(splitIn(OTHER_TAB, OTHER_PANE, "p-keep-b"))).toBe(true);
    const { value } = await b.hc.call("doc.get", { name: LAYOUT_DOC });
    expect(outsideTrees(value, [DEEP_TAB, OTHER_TAB])).toBe(outsideTrees(FIXTURE, [DEEP_TAB, OTHER_TAB]));
    for (const tab of [DEEP_TAB, OTHER_TAB]) {
      for (const { id, before, after } of untouchedNodes(value, tab))
        expect({ id, json: after }).toEqual({ id, json: before });
    }
    const target = nodeById(tabById(value, DEEP_TAB)?.["root"] ?? null, DEEPEST);
    const written = nodeById(tabById(FIXTURE, DEEP_TAB)?.["root"] ?? null, DEEPEST);
    expect(sizeless(target)).toBe(sizeless(written));
    expect(sizeless(target)).toContain("x-future-pane");
  }, 60_000);

  test("two devices that split the same tab at once both keep their split", async () => {
    const [a, b] = both();
    await startFrom(a, b);
    const conflictsBefore = a.conflicts() + b.conflicts();
    const [first, second] = await Promise.all([
      a.layout.edit(splitIn(DEEP_TAB, DEEPEST, "p-same-a")),
      b.layout.edit(splitIn(DEEP_TAB, DEEPEST, "p-same-b")),
    ]);
    expect([first, second]).toEqual([true, true]);
    expect(a.conflicts() + b.conflicts()).toBeGreaterThan(conflictsBefore);
    const { value } = await b.hc.call("doc.get", { name: LAYOUT_DOC });
    expect(panesIn(value, DEEP_TAB)).toEqual(expect.arrayContaining(["p-same-a", "p-same-b"]));
    expect(outsideTrees(value, [DEEP_TAB])).toBe(outsideTrees(FIXTURE, [DEEP_TAB]));
  }, 60_000);
});
