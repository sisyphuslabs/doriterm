import type { MachineView, Terminal } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import { machineEntries, machineKey, onlyThisMachine, orderMachines, showMachines } from "./machines.ts";
import { machineId, toSpaces } from "./model.ts";

const terminal = (address: string, fields: Partial<Terminal> = {}): Terminal => ({
  address,
  argv: ["sh"],
  cols: 80,
  rows: 24,
  created_ms: 0,
  cwd: "/work/doriface",
  labels: {},
  screen: "exact",
  state: "live",
  ...fields,
});

const view = (name: string, state: string): MachineView => ({
  name,
  state,
  host: name,
  id: `${name}-id`,
  target: "doriface-host connect x",
  version: "0.1.17",
  via: true,
});

describe("machineEntries", () => {
  test("this machine first, then each added machine with its state and live terminals", () => {
    const terminals = [
      terminal("t1"),
      terminal("boxb/t1"),
      terminal("boxb/t2"),
      terminal("boxb/t3", { state: "finished" }),
      terminal("t2"),
    ];
    expect(machineEntries("studio", [view("boxb", "connected"), view("lab", "unreachable")], terminals)).toEqual([
      { id: "local", name: "studio", local: true, state: "connected", live: 2, first: "t1" },
      { id: "machine:boxb", name: "boxb", local: false, state: "connected", live: 2, first: "boxb/t1" },
      { id: "machine:lab", name: "lab", local: false, state: "unreachable", live: 0, first: undefined },
    ]);
  });

  test("added machines are listed by name, not in the order this host happened to learn of them", () => {
    const learned = [
      view("c", "connected"),
      view("b", "connected"),
      view("box10", "connected"),
      view("box9", "connected"),
    ];
    expect(orderMachines(learned).map((machine) => machine.name)).toEqual(["b", "box9", "box10", "c"]);
  });

  test("the refresh key changes when an added machine's terminals stop being live, as they do when its line drops", () => {
    const live = [terminal("t1"), terminal("boxb/t1"), terminal("boxb/t2")];
    const dropped = [
      terminal("t1"),
      terminal("boxb/t1", { state: "finished" }),
      terminal("boxb/t2", { state: "finished" }),
    ];
    expect(machineKey(dropped)).not.toBe(machineKey(live));
    expect(machineKey([...live, terminal("t9", { state: "finished" })])).toBe(machineKey(live));
  });
});

describe("showMachines", () => {
  test("the section shows with only this machine too, which is where the person learns how to add one", () => {
    const onlyThis = machineEntries("studio", [], []);
    const withOne = machineEntries("studio", [view("boxb", "connected")], []);
    expect(showMachines(onlyThis, undefined)).toBe(true);
    expect(onlyThisMachine(onlyThis)).toBe(true);
    expect(showMachines(withOne, undefined)).toBe(true);
    expect(onlyThisMachine(withOne)).toBe(false);
    expect(showMachines([], "connection is closed")).toBe(true);
  });
});

describe("selection with an added machine named like this one", () => {
  test("rows get distinct ids, and only the machine the active terminal is on is selected", () => {
    const entries = machineEntries("boxb", [view("boxb", "connected")], [terminal("t1"), terminal("boxb/t1")]);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
    const selected = (active: string) => entries.filter((entry) => entry.id === machineId(active));
    expect(selected("boxb/t1").map((entry) => entry.local)).toEqual([false]);
    expect(selected("t1").map((entry) => entry.local)).toEqual([true]);
  });
});

describe("toSpaces grouped by machine", () => {
  test("this machine's spaces come first, then each machine's, in name order", () => {
    const spaces = toSpaces([
      terminal("zeta/t1", { cwd: "/w/api" }),
      terminal("t1", { cwd: "/w/web" }),
      terminal("boxb/t1", { cwd: "/w/infra" }),
      terminal("t2", { cwd: "/w/api" }),
    ]);
    expect(spaces.map((space) => [space.machine ?? "", space.name])).toEqual([
      ["", "web"],
      ["", "api"],
      ["boxb", "infra"],
      ["zeta", "api"],
    ]);
  });

  test("machines with numbered names group in the same order as the Machines list, box9 before box10", () => {
    const spaces = toSpaces([terminal("box10/t1", { cwd: "/w/a" }), terminal("box9/t1", { cwd: "/w/b" })]);
    const listed = orderMachines([view("box10", "connected"), view("box9", "connected")]);
    expect(spaces.map((space) => space.machine)).toEqual(listed.map((machine) => machine.name));
  });
});
