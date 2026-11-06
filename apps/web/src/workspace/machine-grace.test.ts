import type { MachineView } from "@doriface/protocol";
import { expect, test } from "bun:test";
import { graceEnds, graceViews, OFFLINE_GRACE_MS, stepHeld, type Held } from "./machine-grace.ts";
import { withReach } from "./reach.ts";

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

test("a connected machine whose line is redialing reads connected until the grace ends, then offline", () => {
  const connected = [machine("rack", "connected")];
  const dropped = [machine("rack", "unreachable", 1_000)];
  const held = stepHeld(NONE, { views: connected, at: 0 }, dropped, 1_050);
  expect(shown(dropped, held, 1_050)).toEqual([["rack", "connected"]]);
  expect(graceViews(dropped, held, 1_050)[0]).toMatchObject({ why: null, since_ms: null });
  const again = stepHeld(held, { views: dropped, at: 1_050 }, dropped, 1_050 + 30_000);
  expect(again.get("id-rack")).toBe(1_000);
  expect(shown(dropped, again, 1_000 + OFFLINE_GRACE_MS - 1)).toEqual([["rack", "connected"]]);
  expect(shown(dropped, again, 1_000 + OFFLINE_GRACE_MS)).toEqual([["rack", "unreachable"]]);
  expect(stepHeld(again, { views: dropped, at: 31_050 }, dropped, 1_000 + OFFLINE_GRACE_MS).size).toBe(0);
});

test("a line back inside the grace never showed anything but connected, and a second drop starts a fresh grace", () => {
  const connected = [machine("rack", "connected")];
  const dropped = [machine("rack", "connecting")];
  const held = stepHeld(NONE, { views: connected, at: 0 }, dropped, 5_000);
  expect(shown(dropped, held, 10_000)).toEqual([["rack", "connected"]]);
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

test("a machine never seen connected is held only on the page's first read, and only when hc says when it dropped", () => {
  const later = { views: [machine("rack", "connected")], at: 90_000 };
  const added = [machine("rack", "connected"), machine("new", "connecting")];
  expect(stepHeld(NONE, later, added, 100_000).size).toBe(0);
  expect(stepHeld(NONE, later, [machine("new", "unreachable", 99_000)], 100_000).size).toBe(0);
  expect(stepHeld(NONE, FIRST, [machine("rack", "connecting")], 100_000).size).toBe(0);
});

test("a page opened mid-blip holds a machine only for what is left of the grace after hc's own since", () => {
  const blip = [machine("rack", "unreachable", 10_000)];
  const held = stepHeld(NONE, FIRST, blip, 30_000);
  expect(shown(blip, held, 30_000)).toEqual([["rack", "connected"]]);
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
  expect(states).toEqual([...Array(4).fill("connected"), ...Array(8).fill("unreachable")]);
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
  expect(withReach([live], graceViews(dropped, held, 44_000))[0]?.offline).toBeUndefined();
  expect(withReach([live], graceViews(dropped, held, OFFLINE_GRACE_MS))[0]?.offline).toBe(true);
});
