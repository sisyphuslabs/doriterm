import type { MachineView, Terminal } from "@doriface/protocol";
import { expect, test } from "bun:test";
import { groupAgents } from "./model.ts";
import { withReach } from "./reach.ts";

const terminal = (address: string, state = "live"): Terminal => ({
  address,
  argv: ["sh"],
  cols: 80,
  rows: 24,
  created_ms: 0,
  cwd: "/work/api",
  labels: {},
  screen: "exact",
  state,
  status: { state: "working" },
});

const machine = (name: string, state: string): MachineView => ({
  name,
  state,
  id: `id-${name}`,
  host: name,
  target: name,
  version: "0.1.17",
});

test("an offline terminal that did not change is the same object on the next render, so its pane does not draw again (#2086)", () => {
  const terminals = [terminal("t1"), terminal("build/t1")];
  const away = [machine("build", "unreachable")];
  const first = withReach(terminals, away);
  const next = withReach([...terminals], away);
  expect(next[1]?.offline).toBe(true);
  expect(next[1]).toBe(first[1]);
  expect(next[0]).toBe(terminals[0]);
});

test("only the live terminals of a machine that is not connected leave Working for Offline", () => {
  const terminals = [terminal("t1"), terminal("build/t1"), terminal("build/t2", "finished"), terminal("rack/t1")];
  const reached = withReach(terminals, [machine("build", "unreachable"), machine("rack", "connected")]);
  expect(reached.map((entry) => [entry.state, entry.offline ?? false])).toEqual([
    ["live", false],
    ["live", true],
    ["finished", false],
    ["live", false],
  ]);
  const groups = groupAgents(reached, 0);
  expect(groups.working.map((agent) => agent.id)).toEqual(["t1", "rack/t1"]);
  expect(groups.offline.map((agent) => [agent.id, agent.status])).toEqual([["build/t1", "unknown"]]);
});

test.each([
  ["connecting", false],
  ["unreachable", true],
  ["needs_login", true],
] as const)("a machine that is %s marks its sessions offline: %p", (state, offline) => {
  const [reached] = withReach([terminal("build/t1")], [machine("build", state)]);
  expect(reached?.offline ?? false).toBe(offline);
});
