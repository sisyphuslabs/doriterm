import type { Agent } from "@doriface/ui";
import { expect, test } from "bun:test";
import { sameAgent } from "./steady-agents.ts";

const agent: Agent = { id: "t1", name: "claude", status: "working", detail: "api", age: "2m" };

test("a sidebar row is kept only while every field it draws is the same, its icon included (#2098)", () => {
  const icon = <span>robot</span>;
  expect(sameAgent({ ...agent, icon }, { ...agent, icon })).toBe(true);
  expect(sameAgent({ ...agent, icon }, { ...agent, icon: <span>shell</span> })).toBe(false);
  expect(sameAgent(agent, { ...agent, icon })).toBe(false);
});

test("a row is drawn again when only its place in the tree changed (#2746)", () => {
  const nested: Agent = { ...agent, depth: 1, guides: ["│", "└"], descendants: 2, urgency: "working" };
  expect(sameAgent(nested, { ...nested, guides: ["│", "└"] })).toBe(true);
  expect(sameAgent(agent, { ...agent, depth: 0, guides: [], descendants: 0 })).toBe(true);
  expect(sameAgent(nested, { ...nested, depth: 2 })).toBe(false);
  expect(sameAgent(nested, { ...nested, guides: ["", "└"] })).toBe(false);
  expect(sameAgent(nested, { ...nested, descendants: 3 })).toBe(false);
  expect(sameAgent(nested, { ...nested, urgency: "blocked" })).toBe(false);
});

test("a row is drawn again when only its agent mark kind changed (#2746)", () => {
  expect(sameAgent({ ...agent, kind: "claude" }, { ...agent, kind: "claude" })).toBe(true);
  expect(sameAgent({ ...agent, kind: "claude" }, { ...agent, kind: "codex" })).toBe(false);
  expect(sameAgent(agent, { ...agent, kind: "claude" })).toBe(false);
});
