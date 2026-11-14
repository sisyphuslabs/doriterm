import { HcRpcError, type MachineView } from "@doriface/protocol";
import { expect, test } from "bun:test";
import { graceEnds, graceViews, machineGone, OFFLINE_GRACE_MS, stepHeld, type Held } from "./machine-grace.ts";
import { machineEntries } from "./machines.ts";
import { withReach } from "./reach.ts";
import { startTerminal } from "./start-on.ts";

const machine = (name: string, state: string, since_ms: number | null = null): MachineView => ({
  name,
  state,
  id: `id-${name}`,
  host: name,
  target: name,
  version: "0.1.17",
  since_ms,
  why: state === "unreachable" ? "cannot reach: the mesh settles for 13 s" : null,
});

const NONE: Held = new Map();
const FIRST = { views: [], at: undefined };

const shown = (list: readonly MachineView[], held: Held, now: number) =>
  graceViews(list, held, now).map((view) => [view.name, view.state]);

test("an unreachable host is not labelled connected while creation correctly reports not connected", async () => {
  const dropped = [machine("rack", "unreachable", 1_000)];
  const held = stepHeld(NONE, { views: [machine("rack", "connected")], at: 0 }, dropped, 1_050);

  const visible = graceViews(dropped, held, 1_050);
  const entries = machineEntries({ id: "local", name: "local" }, visible, []);
  const created = await startTerminal(
    () =>
      Promise.reject(new HcRpcError({ code: -32000, message: "rack is unreachable", data: { kind: "unavailable" } })),
    { on: "rack" },
    "local",
  );

  expect(created).toEqual({
    ok: false,
    failure: { machine: "rack", kind: "unavailable", message: "rack is not connected" },
  });
  expect(entries.find((entry) => entry.name === "rack")?.state).toBe("reconnecting");
});

test("a connected machine whose line is redialing reads reconnecting until the grace ends, then offline", () => {
  const connected = [machine("rack", "connected")];
  const dropped = [machine("rack", "unreachable", 1_000)];
  const held = stepHeld(NONE, { views: connected, at: 0 }, dropped, 1_050);
  expect(shown(dropped, held, 1_050)).toEqual([["rack", "reconnecting"]]);
  expect(graceViews(dropped, held, 1_050)[0]).toMatchObject({ why: dropped[0]?.why, since_ms: 1_000 });
  const again = stepHeld(held, { views: dropped, at: 1_050 }, dropped, 1_050 + 30_000);
  expect(again.get("id-rack")).toBe(1_000);
  expect(shown(dropped, again, 1_000 + OFFLINE_GRACE_MS - 1)).toEqual([["rack", "reconnecting"]]);
  expect(shown(dropped, again, 1_000 + OFFLINE_GRACE_MS)).toEqual([["rack", "unreachable"]]);
  expect(stepHeld(again, { views: dropped, at: 31_050 }, dropped, 1_000 + OFFLINE_GRACE_MS).size).toBe(0);
});

test("the slowest return measured on a real relay blip, 62 s after the drop, never reads offline", () => {
  const connected = [machine("workstation", "connected")];
  const dropped = [machine("workstation", "unreachable", 2_000)];
  let held = stepHeld(NONE, { views: connected, at: 0 }, dropped, 4_000);
  let before = { views: dropped, at: 4_000 as number | undefined };
  for (let now = 14_000; now <= 64_000; now += 10_000) {
    held = stepHeld(held, before, dropped, now);
    before = { views: dropped, at: now };
    expect(shown(dropped, held, now)).toEqual([["workstation", "reconnecting"]]);
  }
  expect(stepHeld(held, before, connected, 64_100).size).toBe(0);
});

test("a line back inside the grace leaves reconnecting, and a second drop starts a fresh grace", () => {
  const connected = [machine("rack", "connected")];
  const dropped = [machine("rack", "connecting")];
  const held = stepHeld(NONE, { views: connected, at: 0 }, dropped, 5_000);
  expect(shown(dropped, held, 10_000)).toEqual([["rack", "reconnecting"]]);
  const back = stepHeld(held, { views: dropped, at: 5_000 }, connected, 16_000);
  expect(back.size).toBe(0);
  expect(stepHeld(back, { views: connected, at: 90_000 }, dropped, 100_000).get("id-rack")).toBe(100_000);
});

test("hc's since is kept between the read before and now, whatever the host's clock says", () => {
  const connected = { views: [machine("rack", "connected")], at: 95_000 };
  expect(stepHeld(NONE, connected, [machine("rack", "unreachable", 0)], 100_000).get("id-rack")).toBe(95_000);
  expect(stepHeld(NONE, connected, [machine("rack", "unreachable", 97_000)], 100_000).get("id-rack")).toBe(97_000);
  expect(stepHeld(NONE, connected, [machine("rack", "unreachable", 500_000)], 100_000).get("id-rack")).toBe(100_000);
});

test("a machine that dropped while the page was hidden is held only for what is left of its grace", () => {
  const before = { views: [machine("rack", "connected")], at: 0 };
  const now = 30 * 60_000;
  expect(stepHeld(NONE, before, [machine("rack", "unreachable", now - 29 * 60_000)], now).size).toBe(0);
  expect(stepHeld(NONE, before, [machine("rack", "unreachable", now - 10_000)], now).get("id-rack")).toBe(now - 10_000);
});

test("needs login shows at once, and a machine long down on the page's first read reads offline at once", () => {
  const before = { views: [machine("rack", "connected"), machine("air", "connected")], at: 0 };
  expect(stepHeld(NONE, before, [machine("rack", "needs_login"), machine("air", "connected")], 5_000).size).toBe(0);
  const asleep = [machine("air", "unreachable", 1_000)];
  const first = stepHeld(NONE, FIRST, asleep, 1_000 + 3_600_000);
  expect(shown(asleep, first, 1_000 + 3_600_000)).toEqual([["air", "unreachable"]]);
});

test("a machine never seen connected is held only on the first read, and only when hc says when it dropped", () => {
  const later = { views: [machine("rack", "connected")], at: 90_000 };
  const added = [machine("rack", "connected"), machine("new", "connecting")];
  expect(stepHeld(NONE, later, added, 100_000).size).toBe(0);
  expect(stepHeld(NONE, later, [machine("new", "unreachable", 99_000)], 100_000).size).toBe(0);
  expect(stepHeld(NONE, FIRST, [machine("rack", "connecting")], 100_000).size).toBe(0);
});

/** Steps the hold through reads as useMachines does (first answer, machines read connected), returning what shows. */
function replay(reads: readonly (readonly [number, readonly MachineView[]])[]): string[] {
  let held: Held = NONE;
  let before: Parameters<typeof stepHeld>[1] = FIRST;
  const states: string[] = [];
  for (const [now, views] of reads) {
    held = stepHeld(held, before, views, now);
    const first = before.first ?? { at: now, ids: new Set(views.map((view) => view.id)) };
    const up = new Set(before.up);
    for (const view of views) if (view.state === "connected") up.add(view.id);
    before = { views, at: now, first, up };
    states.push(shown(views, held, now)[0]?.[1] ?? "none");
  }
  return states;
}

test("with the host's clock 25 s ahead, a grace that ended after a drop never holds the machine again", () => {
  const reads: [number, MachineView[]][] = [];
  // Reads at 5, 15, ... s; the line drops at 100 s, which the host's clock calls 125 s.
  for (let now = 5; now <= 95; now += 10) reads.push([now * 1_000, [machine("rack", "connected")]]);
  for (let now = 105; now <= 305; now += 10) reads.push([now * 1_000, [machine("rack", "unreachable", 125_000)]]);
  const states = replay(reads).slice(10);
  const heldReads = Math.ceil(OFFLINE_GRACE_MS / 10_000);
  expect(states).toEqual([...Array(heldReads).fill("reconnecting"), ...Array(21 - heldReads).fill("unreachable")]);
});

test("a page opened while a line redials holds that machine once hc names its drop, and only for what is left", () => {
  const opening = [machine("air", "connecting")];
  const first = { at: 100_000, ids: new Set(["id-air"]) };
  expect(stepHeld(NONE, FIRST, opening, 100_000).size).toBe(0);
  const named = [machine("air", "unreachable", 98_000)];
  const held = stepHeld(NONE, { views: opening, at: 100_000, first }, named, 110_000);
  expect(held.get("id-air")).toBe(98_000);
  expect(shown(named, held, 110_000)).toEqual([["air", "reconnecting"]]);
  const later = { views: named, at: 98_000 + OFFLINE_GRACE_MS, first };
  expect(stepHeld(held, later, named, 98_000 + OFFLINE_GRACE_MS).size).toBe(0);
  expect(stepHeld(NONE, later, named, 98_000 + OFFLINE_GRACE_MS + 10_000).size).toBe(0);
  const ahead = [machine("air", "unreachable", 500_000)];
  expect(stepHeld(NONE, { views: opening, at: 100_000, first }, ahead, 110_000).size).toBe(0);
  const asleep = [machine("air", "unreachable", 1_000)];
  expect(stepHeld(NONE, { views: opening, at: 100_000, first }, asleep, 110_000).size).toBe(0);
  const added = [machine("new", "unreachable", 105_000)];
  expect(stepHeld(NONE, { views: opening, at: 100_000, first }, added, 110_000).size).toBe(0);
});

test("a page opened mid-blip holds a machine only for what is left of the grace after hc's own since", () => {
  const blip = [machine("rack", "unreachable", 10_000)];
  const held = stepHeld(NONE, FIRST, blip, 30_000);
  expect(shown(blip, held, 30_000)).toEqual([["rack", "reconnecting"]]);
  expect(graceEnds(held, 30_000)).toBe(10_000 + OFFLINE_GRACE_MS);
  expect(shown(blip, held, 10_000 + OFFLINE_GRACE_MS)).toEqual([["rack", "unreachable"]]);
  expect(graceEnds(held, 10_000 + OFFLINE_GRACE_MS)).toBeUndefined();
});

test("with the host's clock ahead, a first read holds at most one grace and an ended grace never starts again", () => {
  const ahead = [machine("rack", "unreachable", 3_600_000)];
  let held = stepHeld(NONE, FIRST, ahead, 0);
  expect(held.get("id-rack")).toBe(0);
  const states: string[] = [];
  let before = { views: ahead, at: 0 as number | undefined };
  for (let now = 10_000; now <= 120_000; now += 10_000) {
    held = stepHeld(held, before, ahead, now);
    before = { views: ahead, at: now };
    states.push(shown(ahead, held, now)[0]?.[1] ?? "none");
  }
  const held10 = Math.ceil(OFFLINE_GRACE_MS / 10_000) - 1;
  expect(states).toEqual([...Array(held10).fill("reconnecting"), ...Array(12 - held10).fill("unreachable")]);
});

test("a held machine's live terminals stay live in its grace and read offline once it ends", () => {
  const live = {
    address: "rack/t1",
    argv: ["sh"],
    cols: 80,
    rows: 24,
    created_ms: 0,
    cwd: "/",
    labels: {},
    screen: "exact",
    state: "live",
    status: { state: "working" },
  };
  const dropped = [machine("rack", "unreachable", 0)];
  const held = stepHeld(NONE, { views: [machine("rack", "connected")], at: 0 }, dropped, 0);
  expect(withReach([live], graceViews(dropped, held, OFFLINE_GRACE_MS - 1))[0]?.offline).toBeUndefined();
  expect(withReach([live], graceViews(dropped, held, OFFLINE_GRACE_MS))[0]?.offline).toBe(true);
});

test("a machine is gone, and its actions disabled, only once it reads past its grace (#2455, #2466 review)", () => {
  expect(["connected", "reconnecting"].map(machineGone)).toEqual([false, false]);
  expect(["connecting", "unreachable", "needs_login"].map(machineGone)).toEqual([true, true, true]);
  // A machine the page does not list says nothing about any action.
  expect(machineGone(undefined)).toBe(false);
  // The grace holds a line hc is redialing as reconnecting, so it is not gone until the grace ends.
  const held = graceViews([machine("rack", "unreachable")], new Map([["id-rack", 0]]), 1_000);
  expect(machineGone(held[0]?.state)).toBe(false);
  expect(machineGone(graceViews([machine("rack", "unreachable")], new Map([["id-rack", 0]]), OFFLINE_GRACE_MS)[0]?.state)).toBe(true);
});
