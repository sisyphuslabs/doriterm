import type { JsonObject, Terminal } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import {
  asksBeforeClosing,
  liveTabs,
  runsProgram,
  tabPosition,
  tabTitle,
  phoneTabTitle,
  terminalTitle,
  layoutSpaces,
  type SpacesSource,
} from "./model.ts";

const terminal = (fields: Partial<Terminal>): Terminal => ({
  address: "t1",
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

const front = (argv: string[]) => ({ argv, cwd: "/work", name: argv[0] ?? "", pid: 2 });
const reportedState = (state: string) => ({ state }) as unknown as NonNullable<Terminal["status"]>;
const read = (fields: Partial<Terminal>) => runsProgram(terminal(fields));

describe("closing", () => {
  test("a shell at its prompt and an agent between turns run nothing; a program in front or an agent's turn does", () => {
    expect([
      read({ argv: ["/bin/zsh"], foreground: front(["-zsh"]) }),
      read({ argv: ["/bin/sh"] }),
      read({ argv: ["cmd.exe"] }),
      read({ argv: ["/bin/zsh"], foreground: front(["vim", "notes.md"]) }),
      read({ argv: ["htop"] }),
      read({ argv: ["/bin/zsh"], foreground: front(["claude"]), status: reportedState("working") }),
      read({ argv: ["/bin/zsh"], foreground: front(["claude"]), status: reportedState("idle") }),
      read({ argv: ["/bin/zsh"], foreground: front(["vim"]), state: "finished" }),
    ]).toEqual([false, false, false, true, true, true, false, false]);
  });

  test("confirm-close-surface: false never asks, always always does, and the default asks while a program runs", () => {
    const idle = terminal({ argv: ["/bin/sh"] });
    const busy = terminal({ argv: ["/bin/sh"], foreground: front(["sleep", "600"]) });
    expect([
      asksBeforeClosing("false", [busy]),
      asksBeforeClosing("always", [idle]),
      asksBeforeClosing("true", [idle]),
      asksBeforeClosing("true", [idle, busy]),
      asksBeforeClosing("", [busy]),
    ]).toEqual([false, true, false, true, true]);
  });
});

/** A layout document of these spaces, each tab one row of terminal panes (local addresses). */
const docOf = (
  spaces: readonly { id: string; name?: string; folder?: string; tabs: readonly (readonly string[])[] }[],
): JsonObject => ({
  spaces: spaces.map((space) => ({
    id: space.id,
    name: space.name ?? "",
    folder: space.folder ?? "",
    tabs: space.tabs.map((terminals, index) => ({
      id: `${space.id}-t${index}`,
      name: "",
      root: {
        id: `${space.id}-t${index}`,
        type: "row",
        children: terminals.map((local, at) => ({
          id: `${space.id}-p${index}-${at}`,
          type: "block",
          content: { terminal: local },
        })),
      },
    })),
  })),
});
const here = (doc: JsonObject): SpacesSource => ({ machine: null, machineId: null, doc });
const on = (machine: string, doc: JsonObject): SpacesSource => ({ machine, machineId: `id-${machine}`, doc });

describe("spaces from the layout documents (#404)", () => {
  test("one name on two machines is two spaces, each keyed to its own machine", () => {
    const spaces = layoutSpaces(
      [
        on("box", docOf([{ id: "spc1", folder: "/srv/api", tabs: [["t4"]] }])),
        here(docOf([{ id: "spc1", folder: "/home/me/api", tabs: [["t1"]] }])),
      ],
      [],
    );
    expect(spaces.map((space) => [space.id, space.name, space.machine])).toEqual([
      ["space:spc1", "api", undefined],
      ["space:id-box/spc1", "api", "box"],
    ]);
  });

  test("two folders ending the same way are told apart by their parent (#397); a saved name keeps no suffix", () => {
    const spaces = layoutSpaces(
      [
        here(
          docOf([
            { id: "a", folder: "/Users/yeongyu", tabs: [["t1"]] },
            { id: "b", folder: "/Volumes/data/yeongyu", tabs: [["t2"]] },
            { id: "c", name: "api", folder: "/a/x", tabs: [["t3"]] },
          ]),
        ),
      ],
      [],
    );
    expect(spaces.map((space) => space.name)).toEqual(["yeongyu · Users", "yeongyu · data", "api"]);
  });

  test("a space counts its tabs, is named after its first live terminal when it saves no name or folder, and lists its terminals in tab order", () => {
    const working = { state: "working" } as unknown as NonNullable<Terminal["status"]>;
    const spaces = layoutSpaces(
      [
        here(docOf([{ id: "s", tabs: [["t1", "t2"], ["t3"]] }])),
        on("box", docOf([{ id: "r", folder: "/srv", tabs: [["t9"]] }])),
      ],
      [
        terminal({ address: "t1", cwd: "/w/web", status: working }),
        terminal({ address: "t2", cwd: "/w/other" }),
        terminal({ address: "t3", cwd: "/w/x", state: "finished" }),
      ],
    );
    expect(spaces.map((space) => [space.name, space.tabs, space.attention, space.addresses])).toEqual([
      ["web", 2, "working", ["t1", "t2", "t3"]],
      ["srv", 1, undefined, ["box/t9"]],
    ]);
  });
});

describe("tabPosition", () => {
  const terminals = [
    terminal({ address: "t1" }),
    terminal({ address: "t2" }),
    terminal({ address: "t3", state: "finished" }),
    terminal({ address: "t4" }),
  ];
  const spaces = layoutSpaces([here(docOf([{ id: "s", folder: "/w", tabs: [["t1"], ["t3"], ["t4"]] }]))], terminals);

  test("counts the live terminals of its space's tabs, in tab order", () => {
    expect(tabPosition(spaces, terminals, "t1")).toEqual({ index: 1, count: 2 });
    expect(tabPosition(spaces, terminals, "t4")).toEqual({ index: 2, count: 2 });
  });

  test("a split tab is one tab: every pane has its tab's position and the count does not grow with panes", () => {
    const many = ["t1", "t2", "t3", "t4", "t5"].map((address) => terminal({ address }));
    const listed = layoutSpaces(
      [here(docOf([{ id: "s", folder: "/w", tabs: [["t1"], ["t2", "t3", "t4"], ["t5"]] }]))],
      many,
    );
    expect(["t1", "t2", "t3", "t4", "t5"].map((address) => tabPosition(listed, many, address))).toEqual([
      { index: 1, count: 3 },
      { index: 2, count: 3 },
      { index: 2, count: 3 },
      { index: 2, count: 3 },
      { index: 3, count: 3 },
    ]);
    const first = listed[0];
    expect(first === undefined ? [] : liveTabs(first, many)).toEqual([["t1"], ["t2", "t3", "t4"], ["t5"]]);
  });

  test("a finished terminal, one in no tab and an unknown one have no position", () => {
    expect(tabPosition(spaces, terminals, "t3")).toBeUndefined();
    expect(tabPosition(spaces, terminals, "t2")).toBeUndefined();
    expect(tabPosition(spaces, terminals, "t9")).toBeUndefined();
  });
});

describe("phoneTabTitle", () => {
  test("a phone titles a tab by its own name, else by nothing so its terminal's title shows, never by a place", () => {
    expect(phoneTabTitle("fix login")).toBe("fix login");
    expect(phoneTabTitle("")).toBeNull();
  });
});

describe("tabTitle", () => {
  test("a tab reads its name, else its place counted from 1", () => {
    expect(tabTitle("fix login", 3)).toBe("fix login");
    expect(tabTitle("", 0)).toBe("1");
    expect(tabTitle("", 8)).toBe("9");
  });
});

describe("terminalTitle", () => {
  test("a herdr.name label wins over hc's name and the program's title; an empty one does not count", () => {
    expect(terminalTitle(terminal({ name: "worker", title: "vim", labels: { "herdr.name": "deploy" } }))).toBe(
      "deploy",
    );
    expect(terminalTitle(terminal({ name: "worker", labels: { "herdr.name": "", title: "old" } }))).toBe("worker");
  });
});
