import { LAYOUT_DOC, ORDER_DOC, PINS_DOC, stampOrder, storedPins } from "@doriface/protocol/layout";
import { describe, expect, test } from "bun:test";
import type { RosterChange } from "./changes.ts";
import { FakeCore, machine, space, terminal } from "./fake-core.test-support.ts";
import { Roster } from "./roster.ts";

/** A roster whose fallback timer never fires and whose reopen delay runs at once: only events and gaps move it. */
function rosterOn(core: FakeCore) {
  const timers: string[] = [];
  const changes: RosterChange[] = [];
  const roster = new Roster(core.connection(), {
    every: () => (timers.push("every"), () => undefined),
    whenVisible: () => () => undefined,
    schedule: (run) => (queueMicrotask(run), () => undefined),
    now: () => 1_000,
  });
  roster.onChange((change) => changes.push(change));
  const stop = roster.subscribe(() => undefined);
  return { roster, changes, timers, stop };
}

/** Resolves once `ok` holds, woken only by the roster's own changes; fails loudly instead of hanging. */
function until(roster: Roster, ok: () => boolean, label: string): Promise<void> {
  if (ok()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`timed out waiting for ${label}`));
    }, 2_000);
    const stop = roster.subscribe(() => {
      if (!ok()) return;
      clearTimeout(timer);
      stop();
      resolve();
    });
  });
}

/** The space ids a machine's document lists once read (an unwritten document lists none); undefined before its read. */
const spaceIds = (roster: Roster, on: string | null): readonly string[] | undefined => {
  const state = roster.docs.stateOf(on);
  if (state?.phase !== "ready") return undefined;
  if (state.doc === null) return [];
  const spaces = state.doc["spaces"];
  return Array.isArray(spaces)
    ? spaces.flatMap((each) => (typeof each === "object" && each !== null && "id" in each ? [String(each.id)] : []))
    : [];
};

const settled = (roster: Roster): Promise<void> =>
  until(roster, () => roster.snapshot.machines.listed > 0 && spaceIds(roster, null) !== undefined, "the first reads");

test("pins follow document events and gaps, and stay available after a machine drops", async () => {
  const core = new FakeCore();
  core.machines = [machine("bee")];
  core.setDoc(PINS_DOC, { pinned_tabs: ["t1"] }, "bee", true);
  const { roster, stop } = rosterOn(core);
  const pins = () => [...storedPins(roster.pins.kept("bee-id") ?? null)];
  await until(roster, () => pins().includes("t1"), "bee's first pins");

  core.setDoc(PINS_DOC, { pinned_tabs: ["t2"] }, "bee");
  await until(roster, () => pins().includes("t2"), "bee's pin event");
  core.setDoc(PINS_DOC, { pinned_tabs: ["t3"] }, "bee", true);
  const feed = core.feeds.at(-1);
  if (feed === undefined) throw new Error("no feed opened");
  feed.missed();
  await until(roster, () => pins().includes("t3"), "bee's pins after a gap");

  core.machines = [];
  feed.missed();
  await until(roster, () => roster.pins.live("bee-id") === undefined, "bee's disconnected document");
  expect(pins()).toEqual(["t3"]);
  stop();
});

test("a pin event from an unlisted machine lists it and reads its pins without a timer", async () => {
  const core = new FakeCore();
  const { roster, stop } = rosterOn(core);
  await settled(roster);
  core.machines = [machine("bee")];
  core.setDoc(PINS_DOC, { pinned_tabs: ["t1"] }, "bee");
  await until(roster, () => storedPins(roster.pins.kept("bee-id") ?? null).has("t1"), "the unlisted machine's pins");
  stop();
});

describe("a workspace opened on another device appears here without any action", () => {
  test("the doc event hc sends for the other device's write is enough: the space is on screen with no call of ours", async () => {
    const core = new FakeCore();
    core.setDoc(LAYOUT_DOC, { spaces: [space("s1", "api")] }, null, true);
    const { roster, changes, stop } = rosterOn(core);
    await settled(roster);
    expect(spaceIds(roster, null)).toEqual(["s1"]);
    core.calls.length = 0;

    core.setDoc(LAYOUT_DOC, { spaces: [space("s1", "api"), space("s2", "web")] });

    await until(roster, () => spaceIds(roster, null)?.includes("s2") === true, "the new space");
    expect(spaceIds(roster, null)).toEqual(["s1", "s2"]);
    expect(core.calls).toEqual(["doc.get"]);
    expect(changes.at(-1)).toEqual({
      kind: "space-added",
      machine: null,
      space: { id: "s2", name: "web", folder: "", tabs: [] },
    });
    stop();
  });

  test("a write hc could not deliver (its `missed`) is still read: the gap re-reads every document, as hc asks", async () => {
    const core = new FakeCore();
    core.setDoc(LAYOUT_DOC, { spaces: [space("s1")] }, null, true);
    const { roster, changes, stop } = rosterOn(core);
    await settled(roster);
    const feed = core.feeds.at(-1);
    if (feed === undefined) throw new Error("no feed opened");

    core.setDoc(LAYOUT_DOC, { spaces: [space("s1"), space("s2", "late")] }, null, true);
    feed.missed();

    await until(roster, () => spaceIds(roster, null)?.includes("s2") === true, "the space written inside the gap");
    expect(changes.filter((change) => change.kind === "space-added").map((change) => change.space.id)).toEqual([
      "s1",
      "s2",
    ]);
    stop();
  });

  test("a space opened on an added machine arrives through that machine's doc event, by its name on this core", async () => {
    const core = new FakeCore();
    core.machines = [machine("rohan")];
    core.setDoc(LAYOUT_DOC, { spaces: [space("r1")] }, "rohan", true);
    const { roster, stop } = rosterOn(core);
    await settled(roster);
    await until(roster, () => spaceIds(roster, "rohan-id") !== undefined, "rohan's document");

    core.setDoc(LAYOUT_DOC, { spaces: [space("r1"), space("r2")] }, "rohan");

    await until(roster, () => spaceIds(roster, "rohan-id")?.includes("r2") === true, "rohan's new space");
    stop();
  });
});

describe("a machine added to the fleet appears without a manual step or a timer", () => {
  test("hc's `missed` on the new line's first connection makes the roster read machine.list and the machine's layout", async () => {
    const core = new FakeCore();
    const { roster, changes, timers, stop } = rosterOn(core);
    await settled(roster);
    expect(roster.snapshot.machines.views).toEqual([]);
    const feed = core.feeds.at(-1);
    if (feed === undefined) throw new Error("no feed opened");

    core.machines = [machine("bee")];
    core.setDoc(LAYOUT_DOC, { spaces: [space("b1")] }, "bee", true);
    feed.missed();

    await until(roster, () => roster.snapshot.machines.views.some((view) => view.id === "bee-id"), "bee listed");
    await until(roster, () => spaceIds(roster, "bee-id") !== undefined, "bee's document");
    expect(changes).toContainEqual({ kind: "machine-added", machine: machine("bee") });
    expect(timers).toEqual(["every"]);
    stop();
  });

  test("a terminal starting on a line the roster has not listed yet lists it at once", async () => {
    const core = new FakeCore();
    const { roster, stop } = rosterOn(core);
    await settled(roster);
    const feed = core.feeds.at(-1);
    if (feed === undefined) throw new Error("no feed opened");

    core.machines = [machine("bee")];
    core.terminals = [terminal("bee/t1")];
    feed.emit({ type: "created", terminal: "t1", machine: "bee", data: terminal("bee/t1") });

    await until(roster, () => roster.snapshot.machines.views.some((view) => view.id === "bee-id"), "bee listed");
    stop();
  });
});

describe("a dropped and restored connection reconciles without duplicating or losing a row", () => {
  test("what changed while the link was down arrives as typed changes; every machine and space is listed once", async () => {
    const core = new FakeCore();
    core.machines = [machine("a"), machine("b")];
    core.terminals = [terminal("t1")];
    core.setDoc(LAYOUT_DOC, { spaces: [space("s1"), space("s2", "old")] }, null, true);
    core.setDoc(LAYOUT_DOC, { spaces: [space("b1")] }, "b", true);
    const first = core.connection();
    const changes: RosterChange[] = [];
    const roster = new Roster(first, {
      every: () => () => undefined,
      whenVisible: () => () => undefined,
      schedule: (run) => (queueMicrotask(run), () => undefined),
      now: () => 1_000,
    });
    roster.onChange((change) => changes.push(change));
    const stop = roster.subscribe(() => undefined);
    await settled(roster);
    await until(roster, () => spaceIds(roster, "b-id") !== undefined, "b's document");
    expect(roster.snapshot.machines.views.map((view) => view.name)).toEqual(["a", "b"]);
    changes.length = 0;

    first.drop();
    expect(roster.snapshot.terminals.loaded).toBe(true);
    expect(roster.snapshot.terminals.terminals).toHaveLength(1);
    core.machines = [machine("a"), machine("c")];
    core.setDoc(LAYOUT_DOC, { spaces: [space("s1"), space("s2", "renamed"), space("s3")] }, null, true);
    core.setDoc(LAYOUT_DOC, { spaces: [space("c1")] }, "c", true);
    core.terminals = [terminal("t1"), terminal("t2")];
    roster.attach(core.connection());

    await until(roster, () => roster.snapshot.machines.views.some((view) => view.id === "c-id"), "c listed");
    await until(roster, () => spaceIds(roster, null)?.includes("s3") === true, "the space opened while down");
    await until(roster, () => spaceIds(roster, "c-id") !== undefined, "c's document");
    expect(roster.snapshot.machines.views.map((view) => view.name)).toEqual(["a", "c"]);
    expect(spaceIds(roster, null)).toEqual(["s1", "s2", "s3"]);
    expect(roster.snapshot.terminals.terminals.map((each) => each.address)).toEqual(["t1", "t2"]);
    expect(changes).toContainEqual({ kind: "machine-removed", id: "b-id", name: "b" });
    expect(changes).toContainEqual({ kind: "machine-added", machine: machine("c") });
    expect(changes).toContainEqual({ kind: "space-renamed", machine: null, id: "s2", from: "old", to: "renamed" });
    expect(changes.filter((change) => change.kind === "space-added").map((change) => change.space.id)).toEqual([
      "s3",
      "c1",
    ]);
    expect(changes.filter((change) => change.kind === "machine-added")).toHaveLength(1);
    expect(core.feeds.filter((feed) => !feed.ended())).toHaveLength(1);
    stop();
  });

  test("a feed hc ends while the connection stays is opened again, and the documents are read again with it", async () => {
    const core = new FakeCore();
    core.setDoc(LAYOUT_DOC, { spaces: [space("s1")] }, null, true);
    const { roster, stop } = rosterOn(core);
    await settled(roster);
    const feed = core.feeds.at(-1);
    if (feed === undefined) throw new Error("no feed opened");

    core.setDoc(LAYOUT_DOC, { spaces: [space("s1"), space("s2")] }, null, true);
    feed.end("closed_by_core");

    await until(roster, () => spaceIds(roster, null)?.includes("s2") === true, "the re-read after the reopen");
    expect(core.feeds).toHaveLength(2);
    expect(core.feeds[1]?.ended()).toBe(false);
    stop();
  });
});

describe("a doc event is never lost to a machine list that is behind it (#1876 review)", () => {
  test("a layout event from a machine listed as still connecting lists it again and reads that layout", async () => {
    const core = new FakeCore();
    core.machines = [machine("rohan", "connecting")];
    const { roster, stop } = rosterOn(core);
    await settled(roster);
    expect(spaceIds(roster, "rohan-id")).toBeUndefined();

    core.machines = [machine("rohan")];
    core.setDoc(LAYOUT_DOC, { spaces: [space("r1")] }, "rohan");

    await until(roster, () => spaceIds(roster, "rohan-id")?.includes("r1") === true, "rohan's layout after its event");
    stop();
  });

  test("a layout event under a machine's new name reads that layout again once the list carries the name", async () => {
    const core = new FakeCore();
    core.machines = [machine("rohan")];
    core.setDoc(LAYOUT_DOC, { spaces: [space("r1")] }, "rohan", true);
    const { roster, stop } = rosterOn(core);
    await settled(roster);
    await until(roster, () => spaceIds(roster, "rohan-id")?.includes("r1") === true, "rohan's first layout");

    core.machines = [{ ...machine("rivendell"), id: "rohan-id" }];
    // The fake keys documents by name; hc keeps a renamed machine's document and its version, so carry it over quietly.
    core.setDoc(LAYOUT_DOC, { spaces: [space("r1")] }, "rivendell", true);
    core.setDoc(LAYOUT_DOC, { spaces: [space("r1"), space("r2")] }, "rivendell");

    await until(
      roster,
      () => spaceIds(roster, "rohan-id")?.includes("r2") === true,
      "the layout the renamed event announced",
    );
    stop();
  });

  test("an order event under a machine's new name reads that machine's order again once the list carries the name (#2534 review)", async () => {
    const core = new FakeCore();
    core.machines = [machine("rohan")];
    core.setDoc(ORDER_DOC, { machine_order: ["rohan-id"] }, "rohan", true);
    const { roster, stop } = rosterOn(core);
    await settled(roster);

    core.machines = [{ ...machine("rivendell"), id: "rohan-id" }];
    core.setDoc(ORDER_DOC, { machine_order: ["rohan-id"] }, "rivendell", true);
    // Another device's later write: stamped past whatever this page's first read stamped.
    core.setDoc(
      ORDER_DOC,
      stampOrder({ machine_order: ["rohan-id", "core"] }, { n: 99, at: 1, by: "other" }),
      "rivendell",
    );

    await until(
      roster,
      () => {
        const state = roster.snapshot.order;
        return state.phase === "ready" && JSON.stringify(state.doc).includes('"core"');
      },
      "the order the renamed event announced",
    );
    stop();
  });
});

test("a feed whose reopen fails is opened again later, and the documents are read again with it", async () => {
  const core = new FakeCore();
  core.setDoc(LAYOUT_DOC, { spaces: [space("s1")] }, null, true);
  const { roster, stop } = rosterOn(core);
  await settled(roster);
  const feed = core.feeds.at(-1);
  if (feed === undefined) throw new Error("no feed opened");

  core.failSubscribes = 1;
  core.setDoc(LAYOUT_DOC, { spaces: [space("s1"), space("s2")] }, null, true);
  feed.end("closed_by_core");

  await until(roster, () => spaceIds(roster, null)?.includes("s2") === true, "the re-read after the second reopen");
  expect(core.feeds).toHaveLength(2);
  stop();
});
