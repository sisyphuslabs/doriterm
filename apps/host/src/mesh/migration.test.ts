import { describe, expect, test } from "bun:test";
import { fallbacks } from "@doriface/mesh";
import type { MemberEntry } from "./authorize-index.ts";
import { DIAL_LIMITS } from "./dial-policy.ts";
import { type AddReservation, BUDGET_REFUSAL } from "./line-grants.ts";
import { Reconciler } from "./reconciler.ts";
import { FakeClock } from "./testing/fake-clock.ts";
import { FakeMachines, hcError } from "./testing/fake-machines.ts";
import { hostIdFor } from "./testing/hc-mesh.ts";

const memberOf = (name: string): MemberEntry => ({
  signPub: `sign-${name}`,
  hostId: hostIdFor(name),
  noisePub: `noise-${name}`,
  devicePub: undefined,
  name,
  hcId: `core-${name}`,
});
const self = memberOf("self");
const b = memberOf("b");
const fallback = fallbacks("b", b.hostId)[0] ?? "";
const view = { members: [self, b], overCap: [], revoked: [] };
const OLD = { name: "b", target: "me@box", via: false, id: "core-b", session: "work" } as const;

function reservations(refused: number | undefined) {
  const log: string[] = [];
  const reserve = (): Promise<AddReservation> => {
    if (log.filter((entry) => entry !== "dropped").length + 1 === refused) {
      log.push("refused");
      return Promise.resolve({ ok: false, code: 4429, reason: BUDGET_REFUSAL });
    }
    log.push("reserved");
    return Promise.resolve({ ok: true, failed: () => void log.push("dropped") });
  };
  return { log, reserve };
}

/** `refused` counts the reservations taken, from 1, and names the one the dial budget refuses. */
function setup(refused?: number) {
  const clock = new FakeClock();
  const machines = new FakeMachines(clock);
  machines.seed(OLD);
  machines.failAdds.set("b", [hcError("name_taken")]);
  machines.failAdds.set(fallback, [hcError("already_added")]);
  const pairs = reservations(refused);
  const reconciler = new Reconciler({
    machines,
    program: "/opt/doriface-host",
    stateDir: "/state",
    selfHostId: self.hostId,
    clock,
    log: () => undefined,
    reserve: pairs.reserve,
  });
  const calls = () => machines.calls.map((call) => call.replace(/^\d+ /, ""));
  const listed = async () => (await machines.list()).map((m) => [m.name, m.target, m.via ?? false, m.session]);
  return { clock, machines, pairs, reconciler, calls, listed };
}

describe("replacing an earlier entry for a member's core never leaves the machine out of the list (#710)", () => {
  test("the migration reserves a whole pair of its own: herdr's probe spent one of the pair that met already_added", async () => {
    const { pairs, reconciler, calls, listed } = setup();
    await reconciler.reconcile(view);
    expect(calls()).toEqual(["add b", `add ${fallback}`, "rm b", "add b"]);
    expect(pairs.log).toEqual(["reserved", "dropped", "reserved", "dropped", "reserved"]);
    expect((await listed()).map(([name]) => name)).toEqual(["b"]);
    expect(reconciler.status.get(b.hostId)).toEqual({ state: "ok", replaced: { name: "b", kind: "ssh" } });
  });

  test("a dial budget with no room removes nothing, and another due event respects the retry deadline (#1433)", async () => {
    const { clock, machines, pairs, reconciler, calls, listed } = setup(3);
    await reconciler.reconcile(view);
    expect(pairs.log).toEqual(["reserved", "dropped", "reserved", "dropped", "refused"]);
    expect(calls()).toEqual(["add b", `add ${fallback}`]);
    expect(await listed()).toEqual([["b", "me@box", false, "work"]]);
    expect(reconciler.status.get(b.hostId)).toEqual({ state: "retrying", reason: BUDGET_REFUSAL });
    await reconciler.reconcile(view);
    await reconciler.budgetAvailable(b.hostId);
    await clock.advance(DIAL_LIMITS.probeFirstMs - 1);
    await reconciler.idle();
    expect(calls()).toEqual(["add b", `add ${fallback}`]);
    expect(await listed()).toEqual([["b", "me@box", false, "work"]]);
    machines.failAdds.set("b", [hcError("name_taken")]);
    machines.failAdds.set(fallback, [hcError("already_added")]);
    await clock.advance(1);
    await reconciler.idle();
    expect(calls().slice(2)).toEqual(["add b", `add ${fallback}`, "rm b", "add b"]);
    expect((await listed()).map(([name]) => name)).toEqual(["b"]);
  });

  test("a line that fails to add after the removal puts the earlier entry back as it was, and is retried", async () => {
    const { clock, machines, reconciler, calls, listed } = setup();
    machines.failAdds.set("b", [hcError("name_taken"), hcError("unreachable", "no route")]);
    await reconciler.reconcile(view);
    expect(calls()).toEqual(["add b", `add ${fallback}`, "rm b", "add b", "restore b"]);
    expect(await listed()).toEqual([["b", "me@box", false, "work"]]);
    expect(reconciler.status.get(b.hostId)).toEqual({ state: "retrying", reason: "unreachable: no route" });
    machines.failAdds.set("b", [hcError("name_taken")]);
    machines.failAdds.set(fallback, [hcError("already_added")]);
    await clock.advance(DIAL_LIMITS.probeFirstMs);
    await reconciler.idle();
    expect(calls().slice(5)).toEqual(["add b", `add ${fallback}`, "rm b", "add b"]);
  });

  test("a second already_added after the removal puts the earlier entry back and is STUCK copied core", async () => {
    const { machines, reconciler, calls, listed } = setup();
    machines.failAdds.set("b", [hcError("name_taken"), hcError("already_added")]);
    await reconciler.reconcile(view);
    expect(calls()).toEqual(["add b", `add ${fallback}`, "rm b", "add b", "restore b"]);
    expect(await listed()).toEqual([["b", "me@box", false, "work"]]);
    const status = reconciler.status.get(b.hostId);
    expect(status?.state === "stuck" && status.reason.startsWith("copied core")).toBe(true);
  });

  test("when adding the earlier entry back fails too, status says so and the line is retried", async () => {
    const { machines, reconciler, listed } = setup();
    machines.failAdds.set("b", [hcError("name_taken"), hcError("unreachable", "no route")]);
    machines.failRestores.push(hcError("unreachable", "ssh down"));
    await reconciler.reconcile(view);
    expect(await listed()).toEqual([]);
    expect(reconciler.status.get(b.hostId)).toEqual({
      state: "retrying",
      reason: "unreachable: no route; adding b back failed: ssh down",
    });
  });

  test("a removal herdr refuses gives the reserved pair back, leaves the earlier entry, and is retried (#728)", async () => {
    const { clock, machines, pairs, reconciler, calls, listed } = setup();
    machines.failRms.push(hcError("unreachable", "core busy"));
    await reconciler.reconcile(view);
    expect(calls()).toEqual(["add b", `add ${fallback}`, "rm b"]);
    expect(await listed()).toEqual([["b", "me@box", false, "work"]]);
    expect(pairs.log.at(-1)).toBe("dropped");
    expect(reconciler.status.get(b.hostId)).toEqual({
      state: "retrying",
      reason: "removing b failed: unreachable: core busy",
    });
    machines.failAdds.set("b", [hcError("name_taken")]);
    machines.failAdds.set(fallback, [hcError("already_added")]);
    await clock.advance(DIAL_LIMITS.probeFirstMs);
    await reconciler.idle();
    expect(calls().slice(3)).toEqual(["add b", `add ${fallback}`, "rm b", "add b"]);
  });

  test("the entry a migration removed is still named once a retried add of the line lands (#728)", async () => {
    const { clock, machines, reconciler } = setup();
    machines.failAdds.set("b", [hcError("name_taken"), hcError("unreachable", "no route")]);
    machines.failRestores.push(hcError("unreachable", "ssh down"));
    await reconciler.reconcile(view);
    expect(reconciler.status.get(b.hostId)?.state).toBe("retrying");
    await clock.advance(DIAL_LIMITS.probeFirstMs);
    await reconciler.idle();
    expect(reconciler.status.get(b.hostId)).toEqual({ state: "ok", replaced: { name: "b", kind: "ssh" } });
  });
});
