import { expect, test } from "bun:test";
import type { LayoutTab } from "./layout-model.ts";
import type { MachineView } from "@doriface/protocol";
import {
  absentPanes,
  absentRemotePanes,
  endedForGood,
  endedInView,
  goneFromView,
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

const listed = (address: string, state: string) => ({ address, state });

test("a pane whose terminal the feed lists as finished is asked about like an absent one, unless it is in view (#2122)", () => {
  const terminals = [listed("t1", "live"), listed("t2", "finished"), listed("t3", "finished")];
  const tabs = [tab("a", ["t1"]), tab("b", ["t2"]), tab("c", ["t3"]), tab("d", ["t9"])];
  // t3's tab is the one in view: its view says the session ended and closes from there, so it is left alone.
  expect(absentPanes(tabs, settledPanes(terminals, ["t3"]))).toEqual(["t2", "t9"]);
  expect(absentPanes(tabs, settledPanes(terminals, []))).toEqual(["t2", "t3", "t9"]);
  // A pane in view whose terminal the feed does not list at all is still asked about, as before.
  expect(absentPanes(tabs, settledPanes(terminals, ["t9"]))).toEqual(["t2", "t3", "t9"]);
});

test("an added machine's finished terminal waits like an absent one, and the rename check still reads the whole feed (#2122)", () => {
  const terminals = [listed("box/t4", "finished"), listed("box/t5", "live")];
  const tabs = [tab("box-a", ["box/t4", "box/t5"], false, "box")];
  const feed = new Set(terminals.map((terminal) => terminal.address));
  expect([...absentRemotePanes(tabs, settledPanes(terminals, []), [machine("box", "connected")], feed)]).toEqual([
    ["box/t4", "id-box"],
  ]);
  // The feed still lists the machine under its old name, with finished terminals only: nothing is asked about.
  const renamed = [tab("new-a", ["new/t4"], false, "new")];
  const stale = [listed("old/t4", "finished")];
  const staleFeed = new Set(stale.map((terminal) => terminal.address));
  expect(absentRemotePanes(renamed, settledPanes(stale, []), [machine("new", "connected")], staleFeed).size).toBe(0);
});

test("only a program that exited or was killed is over for good; a lost holder, a stopped server and a live terminal are not (#2122)", () => {
  expect(["exited", "killed"].map((reason) => endedForGood({ state: "finished", reason }))).toEqual([true, true]);
  const kept = ["holder_lost", "server_stop", "stopped_by_restart", "signaled", "host_shutdown", "spawn_pending"];
  expect(kept.map((reason) => endedForGood({ state: "finished", reason }))).toEqual(kept.map(() => false));
  expect(endedForGood({ state: "finished" })).toBe(false);
  // A kept terminal whose program was lost stays live with the loss as its reason, until its shell comes back.
  expect(endedForGood({ state: "live", reason: "killed" })).toBe(false);
});

test("the panes in view whose terminal the feed lists as over are the ones their views say ended (#2146)", () => {
  const terminals = [listed("t1", "live"), listed("t2", "finished"), listed("t3", "finished")];
  expect([...endedInView(terminals, ["t1", "t2", "t9"])]).toEqual(["t2"]);
});

test("a pane left to its view that no tab shows any more went on another device, which had it out of view (#2146)", () => {
  const tabs = [tab("a", ["t1"]), tab("b", ["t2", null])];
  expect(goneFromView(new Set(["t1", "t2", "t3"]), tabs)).toEqual(["t3"]);
  expect(goneFromView(new Set(), tabs)).toEqual([]);
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
