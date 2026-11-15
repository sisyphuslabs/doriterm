import { expect, test } from "bun:test";
import type { LayoutTab } from "./layout-model.ts";
import type { MachineView } from "@doriface/protocol";
import {
  absentPanes,
  absentRemotePanes,
  endedForGood,
  graceLeft,
  JUST_BORN_MS,
  type Missing,
  settledPanes,
  stepMissing,
} from "./use-dead-panes.ts";

const tab = (
  key: string,
  addresses: readonly (string | null)[],
  transient = false,
  machine: string | null = null,
): LayoutTab => ({
  key,
  id: key,
  space: "s",
  spaceKey: "space:s",
  machine,
  name: "",
  root: { children: [], id: key, type: "row" },
  panes: addresses.map((address, index) => ({
    id: `${key}-p${index}`,
    address,
    mod: address === null ? "files" : null,
  })),
  readOnly: null,
  pinned: false,
  transient,
});

test("only this core's document panes whose terminal the feed does not list are asked about, each once", () => {
  const tabs = [
    tab("a", ["t1", "t2"]),
    tab("b", ["t3", null]),
    tab("c", ["t2"]),
    tab("loose:t9", ["t9"], true),
    tab("box-a", ["box/t4"], false, "box"),
  ];
  expect(absentPanes(tabs, new Set(["t1", "t3"]))).toEqual(["t2"]);
  expect(absentPanes(tabs, new Set(["t1", "t2", "t3"]))).toEqual([]);
});

const machine = (name: string, state: string, id = `id-${name}`): MachineView => ({
  host: name,
  id,
  name,
  state,
  target: name,
  version: "0.1.17",
});

test("an added machine's panes are asked about only while machine.list says it is connected", () => {
  const tabs = [
    tab("box-a", ["box/t4", "box/t5"], false, "box"),
    tab("box-loose", ["box/t6"], true, "box"),
    tab("far-a", ["far/t1"], false, "far"),
    tab("a", ["t1"]),
  ];
  const listed = new Set(["t1", "box/t5"]);
  expect([...absentRemotePanes(tabs, listed, [machine("box", "connected"), machine("far", "connecting")])]).toEqual([
    ["box/t4", "id-box"],
  ]);
  for (const state of ["connecting", "unreachable", "needs_login"])
    expect(absentRemotePanes(tabs, listed, [machine("box", state)]).size).toBe(0);
  expect(absentRemotePanes(tabs, listed, []).size).toBe(0);
});

test("while the feed still names a machine machine.list no longer does, no added machine's pane is asked about", () => {
  const tabs = [tab("new-a", ["new/t4"], false, "new")];
  expect(absentRemotePanes(tabs, new Set(["old/t4"]), [machine("new", "connected")]).size).toBe(0);
  expect([...absentRemotePanes(tabs, new Set(["new/t9"]), [machine("new", "connected")])]).toEqual([
    ["new/t4", "id-new"],
  ]);
});

const NOW = 1_000_000;
const born = (address: string, created: number) => ({ address, state: "finished", created_ms: created });
const listed = (address: string, state: string) => ({ address, state, created_ms: 0 });

test("a pane whose terminal the feed lists as finished is asked about like an absent one, in view or not (Q, 2026-11-15)", () => {
  const terminals = [listed("t1", "live"), listed("t2", "finished"), listed("t3", "finished")];
  const tabs = [tab("a", ["t1"]), tab("b", ["t2"]), tab("c", ["t3"]), tab("d", ["t9"])];
  expect(absentPanes(tabs, settledPanes(terminals, NOW).settled)).toEqual(["t2", "t3", "t9"]);
});

test("a terminal's just-born grace runs JUST_BORN_MS from its start and is over at once for an older one", () => {
  expect(graceLeft(NOW - 1_000, NOW)).toBe(JUST_BORN_MS - 1_000);
  expect(graceLeft(NOW - JUST_BORN_MS, NOW)).toBe(0);
  expect(graceLeft(NOW - 60_000, NOW)).toBe(0);
});

test("a terminal that ended within its first seconds keeps its pane for the just-born grace, so its failure shows", () => {
  const tabs = [tab("a", ["t1"]), tab("b", ["t2"])];
  const early = settledPanes([born("t1", NOW - 1_000), born("t2", NOW - JUST_BORN_MS)], NOW);
  expect(absentPanes(tabs, early.settled)).toEqual(["t2"]);
  expect(early.wake).toBe(NOW - 1_000 + JUST_BORN_MS);
  const later = settledPanes([born("t1", NOW - 1_000)], NOW - 1_000 + JUST_BORN_MS);
  expect(absentPanes(tabs, later.settled)).toEqual(["t1", "t2"]);
  expect(later.wake).toBeUndefined();
});

test("an added machine's finished terminal waits like an absent one, and the rename check still reads the whole feed (#2122)", () => {
  const terminals = [listed("box/t4", "finished"), listed("box/t5", "live")];
  const tabs = [tab("box-a", ["box/t4", "box/t5"], false, "box")];
  const feed = new Set(terminals.map((terminal) => terminal.address));
  expect([
    ...absentRemotePanes(tabs, settledPanes(terminals, NOW).settled, [machine("box", "connected")], feed),
  ]).toEqual([["box/t4", "id-box"]]);
  // The feed still lists the machine under its old name, with finished terminals only: nothing is asked about.
  const renamed = [tab("new-a", ["new/t4"], false, "new")];
  const stale = [listed("old/t4", "finished")];
  const staleFeed = new Set(stale.map((terminal) => terminal.address));
  expect(
    absentRemotePanes(renamed, settledPanes(stale, NOW).settled, [machine("new", "connected")], staleFeed).size,
  ).toBe(0);
});

test("only a program that exited or was killed is over for good; a lost holder, a stopped server and a live terminal are not (#2122)", () => {
  expect(["exited", "killed"].map((reason) => endedForGood({ state: "finished", reason }))).toEqual([true, true]);
  const kept = ["holder_lost", "server_stop", "stopped_by_restart", "signaled", "host_shutdown", "spawn_pending"];
  expect(kept.map((reason) => endedForGood({ state: "finished", reason }))).toEqual(kept.map(() => false));
  expect(endedForGood({ state: "finished" })).toBe(false);
  // A kept terminal whose program was lost stays live with the loss as its reason, until its shell comes back.
  expect(endedForGood({ state: "live", reason: "killed" })).toBe(false);
});

test("an absent remote pane is asked about only once a later machine.list read still finds it absent on that machine", () => {
  const absent = new Map([["box/t4", "id-box"]]);
  const first = stepMissing(new Map(), absent, 1);
  expect(first.ask).toEqual([]);
  expect(stepMissing(first.missing, absent, 1).ask).toEqual([]);
  expect(stepMissing(first.missing, absent, 2).ask).toEqual(["box/t4"]);
});

test("a remote pane listed again, or now on another machine, starts its wait over", () => {
  const seen: ReadonlyMap<string, Missing> = new Map([["box/t4", { read: 1, machine: "id-box" }]]);
  const listedAgain = stepMissing(seen, new Map(), 2);
  expect([...listedAgain.missing]).toEqual([]);
  expect(stepMissing(listedAgain.missing, new Map([["box/t4", "id-box"]]), 3).ask).toEqual([]);
  const moved = stepMissing(seen, new Map([["box/t4", "id-other"]]), 2);
  expect(moved.ask).toEqual([]);
  expect(moved.missing.get("box/t4")).toEqual({ read: 2, machine: "id-other" });
});
