import { describe, expect, test } from "bun:test";
import type { Agent, Space } from "@doriface/ui";
import type { MachineEntry } from "./machines.ts";
import type { AgentGroup, MachineGroup } from "./sidebar-model.ts";
import { filterAgentGroups, filterMachineGroups, filterSpaces, matchesQuery } from "./sidebar-filter.ts";

const agent = (id: string, name: string, extra: Partial<Agent> = {}): Agent => ({
  id,
  name,
  status: "idle",
  ...extra,
});
const group = (key: string, agents: readonly Agent[]): AgentGroup => ({
  key,
  title: key,
  compactBlocked: false,
  agents,
  count: agents.length,
});
const space = (id: string, name: string, machine?: string): Space => ({
  id,
  name,
  tabs: 1,
  ...(machine === undefined ? {} : { machine }),
});
const machine = (name: string, local = false): MachineEntry => ({
  id: `m:${name}`,
  core: `core-${name}`,
  name,
  local,
  state: "connected",
  live: 1,
  first: undefined,
});

describe("matchesQuery", () => {
  test("a query matches a label holding its letters in order, any case, gaps allowed", () => {
    expect(matchesQuery("cld", ["Claude Code"])).toBe(true);
    expect(matchesQuery("CLAUDE", ["claude"])).toBe(true);
    expect(matchesQuery("dlc", ["Claude"])).toBe(false);
  });

  test("each word of the query must match one of the labels", () => {
    expect(matchesQuery("claude api", ["claude", "api · laptop"])).toBe(true);
    expect(matchesQuery("claude web", ["claude", "api · laptop"])).toBe(false);
  });

  test("an empty or blank query matches everything", () => {
    expect(matchesQuery("", [])).toBe(true);
    expect(matchesQuery("   ", ["x"])).toBe(true);
  });
});

describe("filterAgentGroups", () => {
  const claude = agent("a1", "claude", { detail: "api" });
  const codex = agent("a2", "codex", { machine: "laptop" });
  const zsh = agent("a3", "zsh", { detail: "web" });
  const groups = [group("working", [claude, codex]), group("idle", [zsh])];

  test("a cleared query gives back the very same groups", () => {
    expect(filterAgentGroups(groups, "", null)).toBe(groups);
    expect(filterAgentGroups(groups, "  ", "a1")).toBe(groups);
  });

  test("only matching rows stay, by the name, detail or machine the row shows; empty groups go; counts follow", () => {
    expect(filterAgentGroups(groups, "laptop", null)).toEqual([group("working", [codex])]);
    expect(filterAgentGroups(groups, "web", null)).toEqual([group("idle", [zsh])]);
  });

  test("membership only: the kept rows are the same objects, in the same order", () => {
    const kept = filterAgentGroups(groups, "c", null);
    expect(kept.flatMap((one) => one.agents)).toEqual([claude, codex]);
    expect(kept[0]?.agents[0]).toBe(claude);
  });

  test("the selected row stays as context even when it does not match", () => {
    expect(filterAgentGroups(groups, "laptop", "a3").map((one) => one.agents.map((row) => row.id))).toEqual([
      ["a2"],
      ["a3"],
    ]);
  });

  test("a hidden field is not searched: the agent's id is not a label", () => {
    expect(filterAgentGroups(groups, "a1", null)).toEqual([]);
  });
});

describe("filterSpaces", () => {
  const spaces = [space("s1", "api", "laptop"), space("s2", "web"), space("s3", "docs")];

  test("a cleared query gives back the very same list", () => {
    expect(filterSpaces(spaces, "", null)).toBe(spaces);
  });

  test("matching by name or machine; the selected space is kept", () => {
    expect(filterSpaces(spaces, "lap", null).map((one) => one.id)).toEqual(["s1"]);
    expect(filterSpaces(spaces, "web", "s3").map((one) => one.id)).toEqual(["s2", "s3"]);
  });

  test("the git branch a row shows is a label too", () => {
    const branched = [
      { ...space("s4", "api"), git: { branch: "fix/parser", detached: false, ahead: 1, behind: 0, dirty: false } },
    ];
    expect(filterSpaces(branched, "parser", null).map((one) => one.id)).toEqual(["s4"]);
  });

  test("the machine is not searched where the row hides it", () => {
    expect(filterSpaces(spaces, "lap", null, { hideMachine: true })).toEqual([]);
  });
});

describe("filterMachineGroups", () => {
  const groups: MachineGroup[] = [
    { machine: machine("studio", true), spaces: [space("s1", "api"), space("s2", "web")] },
    { machine: machine("laptop"), spaces: [space("s3", "docs", "laptop")] },
  ];

  test("a cleared query gives back the very same groups", () => {
    expect(filterMachineGroups(groups, "", null)).toBe(groups);
  });

  test("a machine whose name matches keeps all its spaces", () => {
    expect(filterMachineGroups(groups, "studio", null).map((one) => [one.machine.name, one.spaces.length])).toEqual([
      ["studio", 2],
    ]);
  });

  test("otherwise a machine shows only its matching spaces, and goes when none match", () => {
    expect(
      filterMachineGroups(groups, "web", null).map((one) => [one.machine.name, one.spaces.map((s) => s.id)]),
    ).toEqual([["studio", ["s2"]]]);
  });

  test("the selected space keeps its machine in view", () => {
    expect(
      filterMachineGroups(groups, "web", "s3").map((one) => [one.machine.name, one.spaces.map((s) => s.id)]),
    ).toEqual([
      ["studio", ["s2"]],
      ["laptop", ["s3"]],
    ]);
  });
});
