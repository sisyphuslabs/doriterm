import type { Agent } from "@doriface/ui";
import { expect, test } from "bun:test";
import { sameAgent } from "./agents-group.tsx";

const agent: Agent = { id: "t1", name: "claude", status: "working", detail: "api", age: "2m" };

test("a sidebar row is kept only while every field it draws is the same, its icon included (#2098)", () => {
  const icon = <span>robot</span>;
  expect(sameAgent({ ...agent, icon }, { ...agent, icon })).toBe(true);
  expect(sameAgent({ ...agent, icon }, { ...agent, icon: <span>shell</span> })).toBe(false);
  expect(sameAgent(agent, { ...agent, icon })).toBe(false);
});
