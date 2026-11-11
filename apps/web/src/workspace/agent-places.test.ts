import type { Terminal } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import { type AgentPlaces, placeAgents, SETTLE_MS } from "./agent-places.ts";
import { agentGroups } from "./sidebar-model.ts";

const agent = (address: string, state: string): Terminal => ({
  address,
  argv: ["omo"],
  cols: 80,
  rows: 24,
  created_ms: 0,
  cwd: "/work/api",
  labels: { space: "api" },
  screen: "exact",
  state: "live",
  reported: true,
  status: { state, msg: "2 monitors live" },
});

const placesAfter = (steps: readonly (readonly [number, readonly Terminal[]])[]): AgentPlaces =>
  steps.reduce<AgentPlaces>((places, [at, terminals]) => placeAgents(places, terminals, at).places, new Map());

const statusOf = (places: AgentPlaces, address: string) => places.get(address)?.status;

describe("placeAgents", () => {
  test("a turn from Working to Idle keeps the row in Working until it has held SETTLE_MS", () => {
    const working = [agent("t1", "working")];
    const idle = [agent("t1", "idle")];
    const early = placesAfter([
      [0, working],
      [1_000, idle],
      [1_000 + SETTLE_MS - 1, idle],
    ]);
    expect(statusOf(early, "t1")).toBe("working");
    const held = placesAfter([
      [0, working],
      [1_000, idle],
      [1_000 + SETTLE_MS, idle],
    ]);
    expect(statusOf(held, "t1")).toBe("idle");
  });

  test("a watch that wakes the agent again before the wait is over leaves the row where it was", () => {
    const steps = [
      [0, [agent("t1", "working")]],
      [1_000, [agent("t1", "idle")]],
      [1_000 + SETTLE_MS - 1, [agent("t1", "working")]],
    ] as const;
    const places = placesAfter(steps);
    // Working again with no move waiting: the row stays in Working and nothing falls due once the old wait would end.
    expect(places.get("t1")).toEqual({ status: "working" });
    expect(placeAgents(places, [agent("t1", "working")], 1_000 + SETTLE_MS).due).toBeNull();
  });

  test("an agent that starts working moves to Working at once, also one that never reported before", () => {
    const fresh: Terminal = { ...agent("t1", "idle"), status: null, reported: false };
    const places = placesAfter([
      [0, [fresh]],
      [1, [agent("t1", "working")]],
    ]);
    expect(statusOf(places, "t1")).toBe("working");
  });

  test("a finish the screen has already seen reads Idle and moves the row there at once", () => {
    const seenDone = { ...agent("t1", "done"), seen: true };
    const places = placesAfter([
      [0, [agent("t1", "working")]],
      [1, [seenDone]],
    ]);
    expect(places.get("t1")).toEqual({ status: "idle" });
  });

  test("needing the person and finishing move the row at once", () => {
    for (const state of ["blocked", "done"] as const) {
      const places = placesAfter([
        [0, [agent("t1", "working")]],
        [1, [agent("t1", state)]],
      ]);
      expect(statusOf(places, "t1")).toBe(state);
    }
  });

  test("due is when the oldest pending move falls due, and an unchanged call returns the same places", () => {
    const first = placeAgents(new Map(), [agent("t1", "working"), agent("t2", "working")], 0);
    const pending = placeAgents(first.places, [agent("t1", "idle"), agent("t2", "working")], 2_000);
    expect(pending.due).toBe(2_000 + SETTLE_MS);
    expect(placeAgents(pending.places, [agent("t1", "idle"), agent("t2", "working")], 3_000).places).toBe(
      pending.places,
    );
    expect(placeAgents(first.places, [agent("t1", "working"), agent("t2", "working")], 9_000).due).toBeNull();
  });
});

const names = (groups: ReturnType<typeof agentGroups>) =>
  groups.map((group) => [group.title, group.agents.map((one) => one.id)]);

describe("agentGroups with places (#1949)", () => {
  test("an agent that idles between watch turns keeps its row and its place among the Working rows", () => {
    const before = [agent("t1", "working"), agent("t2", "working"), agent("t3", "working")];
    const after = [agent("t1", "working"), agent("t2", "idle"), agent("t3", "working")];
    const places = placesAfter([
      [0, before],
      [1_000, after],
    ]);
    expect(names(agentGroups(after, 1_000, "status", places))).toEqual([["Working", ["t1", "t2", "t3"]]]);
    const row = agentGroups(after, 1_000, "status", places)[0]?.agents[1];
    expect(row?.status).toBe("idle");
  });

  test("each header counts the rows it lists, a row held in Working through its wait included (#1963)", () => {
    const after = [agent("t1", "idle"), agent("t2", "working")];
    const places = placesAfter([
      [0, [agent("t1", "working"), agent("t2", "working")]],
      [1_000, after],
    ]);
    const groups = agentGroups(after, 1_000, "status", places);
    expect(groups.map((group) => [group.title, group.count])).toEqual([["Working", 2]]);
    expect(groups.every((group) => group.count === group.agents.length)).toBe(true);
  });

  test("once the idle turn has held, the row moves to Idle", () => {
    const before = [agent("t1", "working"), agent("t2", "working")];
    const after = [agent("t1", "working"), agent("t2", "idle")];
    const places = placesAfter([
      [0, before],
      [1_000, after],
      [1_000 + SETTLE_MS, after],
    ]);
    expect(names(agentGroups(after, 1_000 + SETTLE_MS, "status", places))).toEqual([
      ["Working", ["t1"]],
      ["Idle", ["t2"]],
    ]);
  });
});
