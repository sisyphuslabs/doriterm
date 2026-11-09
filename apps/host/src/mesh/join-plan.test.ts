import { parseRecord } from "@doriface/mesh";
import { OPEN_POLICY, parsePolicy, type PlanPolicy } from "@doriface/policy";
import { afterEach, describe, expect, test } from "bun:test";
import {
  admitMembers,
  failure,
  inviteDeps,
  joinerContext,
  ownOf,
  removeSides,
  runJoin,
  side,
} from "../testing/join-harness.ts";
import { PendingJoins } from "./pending-joins.ts";

afterEach(removeSides);

const autoJoins = (): PendingJoins => {
  const pending = new PendingJoins();
  pending.setAuto(Date.now() + 60_000);
  return pending;
};

/** Two machines in `alpha`'s mesh, then `gamma` joins it: the third machine either fits the plan or is refused. */
function thirdMachineJoins(policy: PlanPolicy) {
  const alpha = side("alpha");
  const gamma = side("gamma");
  alpha.mesh.found(alpha.m.identity, ownOf(alpha));
  admitMembers(alpha, ["beta"]);
  return runJoin(
    inviteDeps(alpha, autoJoins(), Date.now() + 60_000, policy),
    joinerContext(gamma, alpha),
    gamma.m.identity.noise.publicKey,
  );
}

describe("the plan gate on mesh size", () => {
  test("a build with no policy admits the third machine, as it does today", async () => {
    const run = thirdMachineJoins(OPEN_POLICY);
    expect(await run.joined).not.toBe("");
    await run.invited;
  });

  test("a plan that allows two machines refuses the third, in words the person joining can act on", async () => {
    const policy = parsePolicy('{"plan":"free","limits":{"machines":2}}');
    const run = thirdMachineJoins(policy);
    expect(await failure(run.invited)).toBe(
      "This mesh has 2 machines, and the free plan allows 2. Remove a machine from the mesh to make room.",
    );
    expect(await failure(run.joined)).toContain("the free plan allows 2");
  });

  test("a plan with room for three admits the third machine", async () => {
    const run = thirdMachineJoins(parsePolicy('{"plan":"free","limits":{"machines":3}}'));
    expect(await run.joined).not.toBe("");
    await run.invited;
  });

  test("a plan limit reached while a join waited for approval refuses it when the approval arrives", async () => {
    const [alpha, delta] = [side("alpha"), side("delta")];
    alpha.mesh.found(alpha.m.identity, ownOf(alpha));
    const pending = new PendingJoins();
    const policy = parsePolicy('{"plan":"free","limits":{"machines":2}}');
    const run = runJoin(
      inviteDeps(alpha, pending, Date.now() + 60_000, policy),
      joinerContext(delta, alpha),
      delta.m.identity.noise.publicKey,
    );
    const asked = await pending.next();
    admitMembers(alpha, ["beta"]); // the plan's second machine, admitted while the join waits
    pending.decide(asked.nonce, true, asked.code);
    expect(await failure(run.invited)).toBe(
      "This mesh has 2 machines, and the free plan allows 2. Remove a machine from the mesh to make room.",
    );
    expect(await failure(run.joined)).toContain("the free plan allows 2");
    const admitted = (alpha.mesh.read()?.records ?? []).filter((record) => parseRecord(record)?.type === "admit");
    expect(admitted).toHaveLength(1); // beta's: the approved join wrote no admit once the limit was reached
    expect(delta.mesh.read()).toBeUndefined();
  });
});
