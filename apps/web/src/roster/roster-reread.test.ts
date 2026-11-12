import { LAYOUT_DOC, ORDER_DOC, PINS_DOC, storedPins } from "@doriface/protocol/layout";
import { expect, test } from "bun:test";
import { FakeCore, space } from "./fake-core.test-support.ts";
import { Roster } from "./roster.ts";
import { spaceIds, until } from "./roster-wait.test-support.ts";

test("a first layout read that fails is read again by itself, with no doc event and no gap", async () => {
  const core = new FakeCore();
  core.setDoc(LAYOUT_DOC, { spaces: [space("s1")] }, null, true);
  // The page's first read after a reload fails once, as a doc.get past its deadline on a loaded host does. Nothing else
  // writes the document afterwards, so no doc event and no gap will ever ask for another read.
  core.failDocGets = 1;
  // The roster's timers are held here and fired by the test, so no wall clock decides when the re-read runs.
  const held: { readonly run: () => void; readonly inMs: number }[] = [];
  const roster = new Roster(core.connection(), {
    every: () => () => undefined,
    whenVisible: () => () => undefined,
    schedule: (run, inMs) => (held.push({ run, inMs }), () => undefined),
    now: () => 1_000,
  });
  const stop = roster.subscribe(() => undefined);

  await until(roster, () => roster.docs.stateOf(null)?.phase === "unavailable", "the failed first read");
  expect(held).toHaveLength(1);
  const [reread] = held;
  if (reread === undefined) throw new Error("no re-read was scheduled");
  expect(reread.inMs).toBeGreaterThan(0);
  reread.run();
  await until(
    roster,
    () => spaceIds(roster, null)?.includes("s1") === true,
    "the layout read again after its failed read",
  );
  expect(core.feeds).toHaveLength(1);
  stop();
});

test("the pins and machine-order documents are read again after their first reads fail, as the layout is", async () => {
  const core = new FakeCore();
  core.setDoc(LAYOUT_DOC, { spaces: [space("s1")] }, null, true);
  core.setDoc(PINS_DOC, { pinned_tabs: ["tb-1"] }, null, true);
  core.setDoc(ORDER_DOC, { machines: ["bee-id"] }, null, true);
  // Every first read fails: this core's layout, its pins and the machine order.
  core.failDocGets = 3;
  const held: (() => void)[] = [];
  const roster = new Roster(core.connection(), {
    every: () => () => undefined,
    whenVisible: () => () => undefined,
    schedule: (run) => (held.push(run), () => undefined),
    now: () => 1_000,
  });
  const stop = roster.subscribe(() => undefined);

  const failed = (): boolean =>
    roster.docs.stateOf(null)?.phase === "unavailable" &&
    roster.pins.stateOf(null)?.phase === "unavailable" &&
    roster.snapshot.order.phase === "unavailable";
  await until(roster, failed, "all three first reads failing");
  expect(held).toHaveLength(3);
  for (const run of held.splice(0)) run();

  await until(
    roster,
    () => roster.pins.stateOf(null)?.phase === "ready" && roster.snapshot.order.phase === "ready",
    "the pins and the machine order read again",
  );
  expect([...storedPins(roster.pins.kept(null) ?? null)]).toEqual(["tb-1"]);
  expect(spaceIds(roster, null)).toEqual(["s1"]);
  stop();
});
