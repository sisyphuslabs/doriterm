import { expect, test } from "bun:test";
import type { LayoutTab } from "./layout-model.ts";
import type { MachineView } from "@doriface/protocol";
import { absentPanes, absentRemotePanes, type Missing, stepMissing } from "./use-dead-panes.ts";

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
