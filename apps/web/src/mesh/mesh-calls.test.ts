import { expect, test } from "bun:test";
import type { HcConnection } from "@doriface/client";
import { FakeCore, machine } from "../roster/fake-core.test-support.ts";
import { Roster } from "../roster/roster.ts";
import { meshCallsOf } from "./use-mesh.ts";

function meshOn(core: FakeCore) {
  const connection = core.connection();
  const roster = new Roster(connection, {
    every: () => () => undefined,
    whenVisible: () => () => undefined,
    schedule: (run) => (queueMicrotask(run), () => undefined),
    now: () => 1_000,
  });
  return { roster, calls: meshCallsOf(connection as unknown as HcConnection, roster) };
}

const listReads = (core: FakeCore): number => core.calls.filter((method) => method === "machine.list").length;

test("a machine.list that fails reaches the mesh read as a failure, not as the machines read before it (#1876 review)", async () => {
  const core = new FakeCore();
  core.machines = [machine("rohan")];
  const { roster, calls } = meshOn(core);
  expect((await calls.machines()).map((view) => view.name)).toEqual(["rohan"]);

  core.failMachineList = true;
  // The roster's own next read (a machine change, a gap, its timer) is the one that fails.
  await roster.refreshMachines();
  await expect(calls.machines()).rejects.toThrow("machine.list failed");
});

test("a mesh read asks machine.list only while the roster has listed nothing, so it never adds reads of its own (#2944)", async () => {
  const core = new FakeCore();
  core.machines = [machine("rohan")];
  const { calls } = meshOn(core);
  await calls.machines();
  const first = listReads(core);
  expect(first).toBeGreaterThan(0);

  await calls.machines();
  await calls.machines();
  expect(listReads(core)).toBe(first);
});
