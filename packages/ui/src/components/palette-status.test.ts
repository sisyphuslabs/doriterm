import { describe, expect, test } from "bun:test";
import type { Command } from "./command-palette.tsx";
import { agentCount, shownStatus, statusCounts, withStatus } from "./palette-status.ts";
import type { AgentStatus } from "./status.tsx";

const agent = (id: string, status: AgentStatus): Command => ({ id, label: id, group: "Agents", status });
const action = (id: string): Command => ({ id, label: id, group: "Actions" });

describe("the palette's state filter (#1454)", () => {
  const commands = [agent("a", "idle"), agent("b", "blocked"), action("x"), agent("c", "working"), agent("d", "idle")];

  test("counts each state the agent rows are in, most urgent first", () => {
    expect(statusCounts(commands)).toEqual([
      { status: "blocked", count: 1 },
      { status: "working", count: 1 },
      { status: "idle", count: 2 },
    ]);
  });

  test("at most the three most urgent states, and never an offline machine's, so the row stays within 2-4 segments", () => {
    const every = [
      agent("a", "idle"),
      agent("b", "done"),
      agent("c", "working"),
      agent("d", "blocked"),
      agent("e", "unknown"),
    ];
    expect(statusCounts(every).map(({ status }) => status)).toEqual(["blocked", "working", "done"]);
    expect(statusCounts([agent("a", "idle"), agent("e", "unknown")])).toEqual([]);
  });

  test("one state, or no agents, filters nothing: no counts at all", () => {
    expect(statusCounts([agent("a", "idle"), agent("b", "idle"), action("x")])).toEqual([]);
    expect(statusCounts([action("x")])).toEqual([]);
    expect(statusCounts([])).toEqual([]);
  });

  test("a chosen state keeps only its agent rows; none keeps every row", () => {
    expect(withStatus(commands, "idle").map((command) => command.id)).toEqual(["a", "d"]);
    expect(withStatus(commands, null)).toBe(commands);
  });

  test("a chosen state no row is in any more falls back to every row", () => {
    const counts = statusCounts(commands);
    expect(shownStatus(counts, "blocked")).toBe("blocked");
    expect(shownStatus(counts, "done")).toBeNull();
    expect(shownStatus([], "idle")).toBeNull();
    expect(shownStatus(counts, null)).toBeNull();
  });

  test("All counts every agent, the states without a segment and an offline machine's included", () => {
    const many = [
      agent("a", "blocked"),
      agent("b", "working"),
      agent("c", "done"),
      agent("d", "idle"),
      agent("e", "unknown"),
      action("x"),
    ];
    expect(statusCounts(many)).toHaveLength(3);
    expect(agentCount(many)).toBe(5);
    expect(withStatus(many, null).filter((command) => command.status !== undefined)).toHaveLength(agentCount(many));
  });
});
