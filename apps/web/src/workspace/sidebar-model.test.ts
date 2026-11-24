import type { Terminal } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import type { MachineEntry } from "./machines.ts";
import { agentStatus } from "./attention.ts";
import { agentGroups, assignColors, foldAgentGroups, machineGroups, PIN_LABEL } from "./sidebar-model.ts";

const terminal = (address: string, state: string | undefined, labels: Record<string, string> = {}): Terminal => ({
  address,
  argv: ["sh"],
  cols: 80,
  rows: 24,
  created_ms: 0,
  cwd: "/work/api",
  labels: { space: "api", ...labels },
  screen: "exact",
  state: "live",
  ...(state === undefined ? {} : { reported: true, status: { state } }),
});

const titles = (groups: ReturnType<typeof agentGroups>) => groups.map((group) => [group.title, group.agents.length]);

describe("agentGroups", () => {
  const fleet = [
    terminal("t1", "done"),
    terminal("t2", "working"),
    terminal("t3", "blocked"),
    terminal("t4", undefined),
    terminal("t5", "working", { space: "web" }),
  ];

  test("by status: Needs you, Working, Idle, Done, each with its count, empty groups left out", () => {
    expect(titles(agentGroups(fleet, 0, "status"))).toEqual([
      ["Needs you", 1],
      ["Working", 2],
      ["Idle", 1],
      ["Done", 1],
    ]);
  });

  test("a pinned agent leaves its status group for Pinned, which comes first and keeps its status", () => {
    const pinned = fleet.map((one) =>
      one.address === "t1" ? { ...one, labels: { ...one.labels, [PIN_LABEL]: "1" } } : one,
    );
    const groups = agentGroups(pinned, 0, "status");
    expect(titles(groups)).toEqual([
      ["Pinned", 1],
      ["Needs you", 1],
      ["Working", 2],
      ["Idle", 1],
    ]);
    expect(groups[0]?.agents[0]).toMatchObject({ id: "t1", status: "done", pinned: true });
  });

  test("each group counts the rows it shows, and per state the sections together count the live agents in it", () => {
    const pinned = fleet.map((one) =>
      one.address === "t2" ? { ...one, labels: { ...one.labels, [PIN_LABEL]: "1" } } : one,
    );
    const groups = agentGroups(pinned, 0, "status");
    for (const group of groups) expect(group.count).toBe(group.agents.length);
    const shown = groups.flatMap((group) => group.agents);
    const live = pinned.filter((one) => one.state === "live");
    const counts = {
      done: live.filter((one) => agentStatus(one) === "done").length,
      working: live.filter((one) => agentStatus(one) === "working").length,
      idle: live.filter((one) => agentStatus(one) === "idle").length,
    };
    for (const state of ["done", "working", "idle"] as const)
      expect(shown.filter((agent) => agent.status === state)).toHaveLength(counts[state]);
    expect(groups.find((group) => group.key === "working")?.count).toBe(1);
    expect(counts.working).toBe(2);
  });

  test("by space: one group per space, its agents most urgent first", () => {
    const groups = agentGroups(fleet, 0, "space");
    expect(titles(groups)).toEqual([
      ["api", 4],
      ["web", 1],
    ]);
    expect(groups[0]?.agents.map((agent) => agent.status)).toEqual(["blocked", "working", "idle", "done"]);
  });
});

const child = (address: string, parent: string, state: string | undefined, labels: Record<string, string> = {}) => ({
  ...terminal(address, state, labels),
  parent,
});

const drawn = (groups: ReturnType<typeof foldAgentGroups>) =>
  groups.map((group) => [group.title, group.count, group.agents.map((agent) => `${agent.id}@${agent.depth}`)]);

describe("agentGroups: sub-agents (#2746)", () => {
  test("a parent is placed by the most urgent of itself and its sub-agents, which follow it and are listed once", () => {
    const fleet = [terminal("t1", undefined), child("t2", "t1", "blocked"), terminal("t3", "working")];
    expect(drawn(agentGroups(fleet, 0, "status"))).toEqual([
      ["Needs you", 2, ["t1@0", "t2@1"]],
      ["Working", 1, ["t3@0"]],
    ]);
  });

  test("a sub-agent's done does not move a working parent out of Working, and its own row still reads done", () => {
    const groups = agentGroups([terminal("t1", "working"), child("t2", "t1", "done")], 0, "status");
    expect(drawn(groups)).toEqual([["Working", 2, ["t1@0", "t2@1"]]]);
    expect(groups[0]?.agents.map((agent) => [agent.status, agent.urgency])).toEqual([
      ["working", "working"],
      ["done", "done"],
    ]);
  });

  test("a row's held place counts for its parent too: a settling sub-agent does not move the parent", () => {
    const fleet = [terminal("t1", undefined), child("t2", "t1", "idle")];
    const places = new Map([["t2", { status: "working" as const }]]);
    expect(drawn(agentGroups(fleet, 0, "status", places))).toEqual([["Working", 2, ["t1@0", "t2@1"]]]);
  });

  test("an offline parent stays in Offline with its sub-agents, a live one keeping its own state", () => {
    const fleet = [{ ...terminal("box/t1", "working"), offline: true as const }, child("t2", "box/t1", "blocked")];
    const groups = agentGroups(fleet, 0, "status");
    expect(drawn(groups)).toEqual([["Offline", 2, ["box/t1@0", "t2@1"]]]);
    expect(groups[0]?.agents.map((agent) => [agent.status, agent.urgency])).toEqual([
      ["unknown", "blocked"],
      ["blocked", "blocked"],
    ]);
  });

  test("the counts together are the live terminals, each once, and folding changes no count", () => {
    const fleet = [
      terminal("t1", "working"),
      child("t2", "t1", "blocked"),
      child("t3", "t2", undefined),
      terminal("t4", "done"),
      { ...terminal("t5", "done"), state: "finished" as const },
    ];
    const groups = agentGroups(fleet, 0, "status");
    expect(groups.reduce((sum, group) => sum + group.count, 0)).toBe(4);
    expect(groups.flatMap((group) => group.agents.map((agent) => agent.id)).toSorted()).toEqual([
      "t1",
      "t2",
      "t3",
      "t4",
    ]);
    const folded = foldAgentGroups(groups, ["t1"], null);
    expect(drawn(folded)).toEqual([
      ["Needs you", 3, ["t1@0"]],
      ["Done", 1, ["t4@0"]],
    ]);
    expect(folded[0]?.agents[0]).toMatchObject({ descendants: 2, urgency: "blocked" });
  });

  test("a fold is drawn open above the selected agent, and nothing folded gives back the same groups", () => {
    const groups = agentGroups([terminal("t1", "working"), child("t2", "t1", "idle")], 0, "status");
    expect(foldAgentGroups(groups, ["t1"], "t2")).toBe(groups);
    expect(foldAgentGroups(groups, [], null)).toBe(groups);
    expect(foldAgentGroups(groups, ["t9"], null)).toBe(groups);
  });

  test("by space: a sub-agent stays under its parent, in the parent's space, whatever its own label", () => {
    const fleet = [
      terminal("t1", "idle"),
      child("t2", "t1", "working", { space: "web" }),
      terminal("t3", "idle", { space: "web" }),
    ];
    expect(drawn(agentGroups(fleet, 0, "space"))).toEqual([
      ["api", 2, ["t1@0", "t2@1"]],
      ["web", 1, ["t3@0"]],
    ]);
  });

  test("a pinned sub-agent is listed once, in Pinned with its own sub-agents, and still bubbles to its parent", () => {
    const fleet = [
      terminal("t1", undefined),
      child("t2", "t1", "blocked", { [PIN_LABEL]: "1" }),
      child("t3", "t2", undefined),
      child("t4", "t1", undefined),
    ];
    const groups = agentGroups(fleet, 0, "status");
    expect(drawn(groups)).toEqual([
      ["Pinned", 2, ["t2@0", "t3@1"]],
      ["Needs you", 2, ["t1@0", "t4@1"]],
    ]);
    expect(groups[1]?.agents.map((agent) => [agent.descendants, agent.guides])).toEqual([
      [1, []],
      [0, ["└"]],
    ]);
  });
});

describe("assignColors", () => {
  test("a new space takes the least used colour; kept spaces keep theirs; gone ones are dropped", () => {
    const first = assignColors({}, ["a", "b"]);
    expect(first).toEqual({ a: "teal", b: "orange" });
    const next = assignColors({ ...first, gone: "blue" }, ["b", "c"]);
    expect(next).toEqual({ b: "orange", c: "teal" });
  });

  test("returns the saved object itself when nothing changed, so it is not written again", () => {
    const saved = { a: "teal" } as const;
    expect(assignColors(saved, ["a"])).toBe(saved);
  });
});

const entry = (name: string, local: boolean): MachineEntry => ({
  id: local ? "local" : `machine:${name}`,
  core: local ? "local-core" : `core:${name}`,
  name,
  local,
  state: "connected",
  first: undefined,
});

describe("machineGroups", () => {
  const spaces = [
    { id: "local/api", name: "api", tabs: 1 },
    { id: "machine:box/api", name: "api", machine: "box", tabs: 2 },
  ];

  test("one machine: no grouping", () => {
    expect(machineGroups([entry("studio", true)], spaces)).toBeUndefined();
  });

  test("more machines: each machine's spaces under it, in the machines' order", () => {
    const groups = machineGroups([entry("studio", true), entry("zeta", false), entry("box", false)], spaces);
    expect(groups?.map((group) => [group.machine.name, group.spaces.map((space) => space.id)])).toEqual([
      ["studio", ["local/api"]],
      ["zeta", []],
      ["box", ["machine:box/api"]],
    ]);
  });

  test("a machine counts what the space rows under it count: the sum of their tabs, also while it is offline (#2122)", () => {
    const listed = [
      { id: "local/api", name: "api", tabs: 1 },
      { id: "local/web", name: "web", tabs: 3 },
      { id: "machine:box/api", name: "api", machine: "box", tabs: 2 },
    ];
    // An offline machine's rows still count the tabs of the document last read from it, so its header does too.
    const box = { ...entry("box", false), state: "unreachable" };
    const groups = machineGroups([entry("studio", true), entry("zeta", false), box], listed);
    expect(groups?.map((group) => [group.machine.name, group.tabs])).toEqual([
      ["studio", 4],
      ["zeta", 0],
      ["box", 2],
    ]);
  });
});
