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
  toAgent,
  layoutSpaces,
  spaceOfAddress,
  type SpacesSource,
} from "./model.ts";
import { adoptLoose } from "./layout-model.ts";

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
const reportedApp = (app: string) => ({ state: "working", app }) as unknown as NonNullable<Terminal["status"]>;
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

  test("spaces made for loose terminals in two folders ending the same way are told apart by their parent (#2670)", () => {
    let next = 0;
    const adopted = adoptLoose(
      null,
      [terminal({ address: "t1", cwd: "/a/work" }), terminal({ address: "t2", cwd: "/b/work" })],
      (prefix) => `${prefix}${(next += 1)}`,
    );
    if (adopted === null) throw new Error("nothing adopted");
    expect(layoutSpaces([here(adopted)], []).map((space) => space.name)).toEqual(["work · a", "work · b"]);
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

  test("a space whose terminal starts in a system directory is named after its shell, never the path (#2658)", () => {
    const spaces = layoutSpaces(
      [
        here(
          docOf([
            { id: "win", tabs: [["t1"]] },
            { id: "root", tabs: [["t2"]] },
            { id: "none", tabs: [["t3"]] },
          ]),
        ),
        on("box", docOf([{ id: "twin", tabs: [["t4"]] }])),
      ],
      [
        terminal({ address: "t1", cwd: "C:\\Windows\\System32", argv: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe"] }),
        terminal({ address: "t2", cwd: "/", argv: ["/bin/bash"] }),
        terminal({ address: "box/t4", cwd: "/usr/bin", argv: ["/bin/bash"] }),
      ],
    );
    expect(spaces.map((space) => space.name)).toEqual(["PowerShell", "Bash", "Space", "Bash"]);
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

  test("an address listed in two spaces resolves to the first, for its position and its space (#1486)", () => {
    const both = layoutSpaces(
      [
        here(
          docOf([
            { id: "first", folder: "/a", tabs: [["t4"], ["t1"]] },
            { id: "second", folder: "/b", tabs: [["t1"]] },
          ]),
        ),
      ],
      terminals,
    );
    expect(both.map((space) => space.name)).toEqual(["a", "b"]);
    expect(spaceOfAddress(both, "t1")?.name).toBe(both[0]?.name);
    expect(spaceOfAddress(both, "t1")).toBe(both[0]);
    expect(tabPosition(both, terminals, "t1")).toEqual({ index: 2, count: 2 });
    expect(spaceOfAddress(both, "t9")).toBeUndefined();
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
  test("a named tab reads its name, even over what it runs", () => {
    expect(tabTitle("fix login", 3, terminal({ name: "claude" }))).toBe("fix login");
    expect(tabTitle("fix login", 3)).toBe("fix login");
  });

  test("an unnamed tab that runs an agent reads the agent's title (#1541)", () => {
    expect(tabTitle("", 0, terminal({ name: "claude" }))).toBe("claude");
    expect(tabTitle("", 2, terminal({ name: "worker", labels: { "herdr.name": "deploy" } }))).toBe("deploy");
  });

  test("an unnamed tab whose pane carries a name reads it, a lane's, never a bare number (#2670)", () => {
    expect(
      tabTitle("", 4, undefined, terminal({ name: "lane doriterm-2670", argv: ["bash", "-c", "sleep 600"] })),
    ).toBe("lane doriterm-2670");
  });

  test("a bare shell keeps its number even when renamed, and a program's window title alone names no tab (#2670, #466)", () => {
    expect(
      tabTitle("", 1, undefined, terminal({ argv: ["zsh", "-l"], labels: { "herdr.name": "deploy-check" } })),
    ).toBe("2");
    expect(tabTitle("", 1, undefined, terminal({ title: "build watcher", argv: ["node", "watch.js"] }))).toBe("2");
    // `env` with its variables only wraps the shell: still a bare shell.
    expect(tabTitle("", 0, undefined, terminal({ name: "parity-a1", argv: ["env", "PS1=$ ", "sh"] }))).toBe("1");
    // `exec` wraps a shell the same way, and `env` with only assignments runs no command: neither is a lane.
    expect(tabTitle("", 0, undefined, terminal({ name: "wrapped", argv: ["exec", "zsh", "-l"] }))).toBe("1");
    expect(tabTitle("", 0, undefined, terminal({ name: "vars-only", argv: ["env", "A=1", "B=2"] }))).toBe("1");
    // A lane: a name given to a command that is not a bare shell.
    expect(tabTitle("", 0, undefined, terminal({ name: "lane-x", argv: ["bash", "-c", "exec sleep 600"] }))).toBe(
      "lane-x",
    );
  });

  test("an unnamed shell pane at a prompt keeps its place counted from 1 (#466)", () => {
    expect(tabTitle("", 3, undefined, terminal({ title: "lo@box: ~/w", argv: ["zsh"] }))).toBe("4");
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

describe("toAgent", () => {
  test("sets kind from agentKind when marked, falling back to agent/shell/program", () => {
    expect(toAgent(terminal({ status: reportedApp("claude") }), 0).kind).toBe("claude");
    expect(toAgent(terminal({ status: reportedApp("unknown-wrapper") }), 0).kind).toBe("agent");
    expect(toAgent(terminal({ argv: ["/bin/zsh"] }), 0).kind).toBe("shell");
    expect(toAgent(terminal({ argv: ["htop"] }), 0).kind).toBe("program");
    expect(toAgent(terminal({ status: reportedApp("kiro") }), 0).kind).toBe("agent");
    expect(toAgent(terminal({ argv: ["kiro"] }), 0).kind).toBe("agent");
  });
});
