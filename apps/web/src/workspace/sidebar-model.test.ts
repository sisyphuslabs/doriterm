import type { Terminal } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import type { MachineEntry } from "./machines.ts";
import { agentStatus } from "./attention.ts";
import { agentGroups, assignColors, machineGroups, PIN_LABEL } from "./sidebar-model.ts";

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
  live: 0,
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
});
