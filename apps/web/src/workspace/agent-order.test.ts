import { afterEach, describe, expect, test } from "bun:test";
import { publishAgentOrder, steppedAgents } from "./agent-order.ts";

let unpublish: (() => void) | undefined;
afterEach(() => {
  unpublish?.();
  unpublish = undefined;
});

describe("steppedAgents", () => {
  const live = ["t1", "t2", "t3"];

  test("before a list has drawn, the agents are stepped in the feed's order", () => {
    expect(steppedAgents(live)).toBe(live);
  });

  test("once a list has drawn, they are stepped in the order it draws them", () => {
    unpublish = publishAgentOrder(["t1", "t3", "t2"]);
    expect(steppedAgents(live)).toEqual(["t1", "t3", "t2"]);
  });

  test("a drawn row that is no longer live is skipped, so a step never opens a terminal that ended", () => {
    unpublish = publishAgentOrder(["t9", "t3", "t1"]);
    expect(steppedAgents(live)).toEqual(["t3", "t1"]);
  });

  test("a list that draws no live agent, as under a query nothing matches, falls back to the feed's order", () => {
    unpublish = publishAgentOrder([]);
    expect(steppedAgents(live)).toBe(live);
  });

  test("a list that went away gives the order back, unless another list has published since", () => {
    const first = publishAgentOrder(["t2", "t1"]);
    unpublish = publishAgentOrder(["t3", "t2", "t1"]);
    first();
    expect(steppedAgents(live)).toEqual(["t3", "t2", "t1"]);
    unpublish();
    expect(steppedAgents(live)).toBe(live);
  });
});
