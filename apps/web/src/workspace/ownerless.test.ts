import { describe, expect, test } from "bun:test";
import { agentTree } from "./agent-tree.ts";
import type { Session } from "./attention.ts";
import { agentGroups } from "./sidebar-model.ts";

const terminal = (address: string, parent: string | null, state: "live" | "finished" = "live"): Session => ({
  address,
  argv: ["sh"],
  cols: 80,
  rows: 24,
  created_ms: 0,
  cwd: "/work/api",
  labels: { space: "api" },
  screen: "exact",
  state,
  parent,
  reported: true,
  status: { state: "working" },
});

const rows = (terminals: readonly Session[]) =>
  agentTree(terminals).map((row) => `${row.address}@${row.depth}${row.ownerless ? " ownerless" : ""}`);

describe("a sub-agent whose parent ended runs on ownerless (#2990)", () => {
  test("under a live parent it is nested and owned", () => {
    expect(rows([terminal("t1", null), terminal("t2", "t1")])).toEqual(["t1@0", "t2@1"]);
  });

  test("once its parent finished it is a top-level row, ownerless, though hc still names that parent", () => {
    expect(rows([terminal("t1", null, "finished"), terminal("t2", "t1"), terminal("t3", "t2")])).toEqual([
      "t2@0 ownerless",
      "t3@1",
    ]);
  });

  test("once its parent is removed from the core it is ownerless too", () => {
    expect(rows([terminal("t2", "t1"), terminal("t5", "box/t4")])).toEqual(["t2@0 ownerless", "t5@0 ownerless"]);
  });

  test("a terminal nobody started is never ownerless", () => {
    expect(rows([terminal("t1", null), { ...terminal("t2", null), parent: "" }])).toEqual(["t1@0", "t2@0"]);
  });

  test("the Agents list carries the mark on the released row only", () => {
    const groups = agentGroups(
      [terminal("t1", null, "finished"), terminal("t2", "t1"), terminal("t3", "t2")],
      0,
      "status",
    );
    expect(groups.flatMap((group) => group.agents.map((agent) => [agent.id, agent.ownerless === true]))).toEqual([
      ["t2", true],
      ["t3", false],
    ]);
  });
});
