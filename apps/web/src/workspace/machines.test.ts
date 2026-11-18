import type { JsonObject } from "@doriface/protocol";
import type { MachineView, Terminal } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import { machineEntries, machineKey, onlyThisMachine, orderMachines } from "./machines.ts";
import { machineId, layoutSpaces, type SpacesSource } from "./model.ts";

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

const STUDIO = { id: "studio-core", name: "studio" };

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
  test("every machine by name, the one this page reaches included, each with its state and the live terminal its header opens; an entry carries no count, its row counts tabs (#2122, #2531)", () => {
    const terminals = [
      terminal("t1"),
      terminal("boxb/t1"),
      terminal("boxb/t2"),
      terminal("boxb/t3", { state: "finished" }),
      terminal("t2"),
    ];
    expect(machineEntries(STUDIO, [view("boxb", "connected"), view("lab", "unreachable")], terminals)).toEqual([
      {
        id: "machine:boxb",
        core: "boxb-id",
        name: "boxb",
        local: false,
        state: "connected",
        first: "boxb/t1",
      },
      { id: "machine:lab", core: "lab-id", name: "lab", local: false, state: "unreachable", first: undefined },
      { id: "local", core: "studio-core", name: "studio", local: true, state: "connected", first: "t1" },
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

describe("onlyThisMachine", () => {
  test("true with only this machine, false once one is added", () => {
    expect(onlyThisMachine(machineEntries(STUDIO, [], []))).toBe(true);
    expect(onlyThisMachine(machineEntries(STUDIO, [view("boxb", "connected")], []))).toBe(false);
  });
});

describe("selection with an added machine named like this one", () => {
  test("rows get distinct ids, and only the machine the active terminal is on is selected", () => {
    const entries = machineEntries(
      { id: "boxb-core", name: "boxb" },
      [view("boxb", "connected")],
      [terminal("t1"), terminal("boxb/t1")],
    );
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
    const selected = (active: string) => entries.filter((entry) => entry.id === machineId(active));
    expect(selected("boxb/t1").map((entry) => entry.local)).toEqual([false]);
    expect(selected("t1").map((entry) => entry.local)).toEqual([true]);
  });
});

/** A layout document of one tab per space, each tab one terminal pane (a local address). */
const docOf = (spaces: readonly { id: string; folder: string; terminal: string }[]): JsonObject => ({
  spaces: spaces.map((space) => ({
    id: space.id,
    name: "",
    folder: space.folder,
    tabs: [
      {
        id: `${space.id}-t`,
        name: "",
        root: {
          id: `${space.id}-t`,
          type: "row",
          children: [{ id: `${space.id}-p`, type: "block", content: { terminal: space.terminal } }],
        },
      },
    ],
  })),
});

const source = (machine: string | null, spaces: Parameters<typeof docOf>[0]): SpacesSource => ({
  machine,
  machineId: machine,
  doc: docOf(spaces),
});

describe("layout spaces grouped by machine (#404)", () => {
  test("this machine's spaces come first, in their document's order, then each machine's, in name order", () => {
    const spaces = layoutSpaces(
      [
        source("zeta", [{ id: "z", folder: "/w/api", terminal: "t1" }]),
        source(null, [
          { id: "w", folder: "/w/web", terminal: "t1" },
          { id: "a", folder: "/w/api", terminal: "t2" },
        ]),
        source("boxb", [{ id: "i", folder: "/w/infra", terminal: "t1" }]),
      ],
      [],
    );
    expect(spaces.map((space) => [space.machine ?? "", space.name])).toEqual([
      ["", "web"],
      ["", "api"],
      ["boxb", "infra"],
      ["zeta", "api"],
    ]);
  });

  test("machines with numbered names group in the same order as the Machines list, box9 before box10", () => {
    const spaces = layoutSpaces(
      [
        source("box10", [{ id: "a", folder: "/w/a", terminal: "t1" }]),
        source("box9", [{ id: "b", folder: "/w/b", terminal: "t1" }]),
      ],
      [],
    );
    const listed = orderMachines([view("box10", "connected"), view("box9", "connected")]);
    expect(spaces.map((space) => space.machine)).toEqual(listed.map((machine) => machine.name));
  });
});
