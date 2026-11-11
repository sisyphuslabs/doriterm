import { expect, test } from "bun:test";
import type { HcConnection } from "@doriface/client";
import { FakeCore, machine } from "../roster/fake-core.test-support.ts";
import { Roster } from "../roster/roster.ts";
import { meshCallsOf } from "./use-mesh.ts";

test("a machine.list that fails reaches the mesh read as a failure, not as the machines read before it (#1876 review)", async () => {
  const core = new FakeCore();
  core.machines = [machine("rohan")];
  const connection = core.connection();
  const roster = new Roster(connection, {
    every: () => () => undefined,
    whenVisible: () => () => undefined,
    schedule: (run) => (queueMicrotask(run), () => undefined),
    now: () => 1_000,
  });
  const calls = meshCallsOf(connection as unknown as HcConnection, roster);
  expect((await calls.machines()).map((view) => view.name)).toEqual(["rohan"]);

  core.failMachineList = true;
  await expect(calls.machines()).rejects.toThrow("machine.list failed");
});
