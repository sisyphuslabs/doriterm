import { describe, expect, test } from "bun:test";
import { Reconciler } from "./reconciler.ts";
import { FakeClock } from "./testing/fake-clock.ts";
import { FakeMachines, hcError } from "./testing/fake-machines.ts";
import { hostIdFor } from "./testing/hc-mesh.ts";
import type { MemberEntry } from "./authorize-index.ts";
import type { MeshView } from "./mesh-view.ts";
import { meshVia } from "./via.ts";

const PROGRAM = "/opt/doriface-host";
const STATE = "/state";
const member = (name: string, hostId = hostIdFor(name)): MemberEntry => ({
  signPub: `sign-${name}`,
  hostId,
  noisePub: `noise-${name}`,
  devicePub: undefined,
  name,
  hcId: `core-${name}`,
});
const [self, b, c] = [member("self"), member("b"), member("c")];
const viewOf = (...members: readonly MemberEntry[]): MeshView => ({
  members: [self, ...members],
  overCap: [],
  revoked: [],
});

function reconciler(): { clock: FakeClock; machines: FakeMachines; reconcile: Reconciler; logs: string[] } {
  const clock = new FakeClock();
  const machines = new FakeMachines(clock);
  const logs: string[] = [];
  const log = (line: string): void => void logs.push(line);
  const options = { machines, program: PROGRAM, stateDir: STATE, selfHostId: self.hostId, clock, log };
  return { clock, machines, reconcile: new Reconciler(options), logs };
}

describe("a member that could not be added (section 8.1, H-54-1)", () => {
  test("an unreachable add is retried on the 30 s backoff, doubling, until it lands, and then left alone", async () => {
    const { clock, machines, reconcile } = reconciler();
    machines.failAdds.set("b", [hcError("unreachable"), hcError("unreachable")]);
    await reconcile.reconcile(viewOf(b));
    expect(reconcile.status.get(b.hostId)?.state).toBe("retrying");
    await clock.advance(30 * 60_000);
    await reconcile.idle();
    expect(machines.calls).toEqual(["0 add b", "30000 add b", "90000 add b"]);
    expect(reconcile.status.get(b.hostId)?.state).toBe("ok");
  });

  test("presence of a member with no machine entry adds it at once", async () => {
    const { machines, reconcile } = reconciler();
    machines.failAdds.set("b", [hcError("unreachable")]);
    await reconcile.reconcile(viewOf(b));
    await reconcile.presence(b);
    await reconcile.idle();
    expect(machines.calls).toEqual(["0 add b", "0 add b"]);
    expect((await machines.list()).map((machine) => machine.name)).toEqual(["b"]);
  });

  test("a member that leaves the view is no longer retried", async () => {
    const { clock, machines, reconcile } = reconciler();
    machines.failAdds.set("b", [hcError("unreachable")]);
    await reconcile.reconcile(viewOf(b));
    await reconcile.reconcile(viewOf());
    await clock.advance(10 * 60_000);
    await reconcile.idle();
    expect(machines.calls).toEqual(["0 add b"]);
  });
});

describe("lines that exist (section 8.1)", () => {
  test("a recreated core (a different core answers there) is removed and added again", async () => {
    const { machines, reconcile } = reconciler();
    const via = meshVia(PROGRAM, STATE, b.hostId);
    machines.seed({ name: "b", target: via, via: true, state: "unreachable", why: "a different core answers there" });
    await reconcile.reconcile(viewOf(b));
    expect(machines.calls).toEqual(["0 rm b", "0 add b"]);
  });

  test("presence while herdr cannot be reached reports it instead of failing the caller", async () => {
    const { machines, reconcile, logs } = reconciler();
    machines.list = () => Promise.reject(hcError("unreachable", "connection is closed"));
    await reconcile.presence(b);
    expect(logs.some((line) => line.includes("connection is closed"))).toBe(true);
  });

  test("presence leaves a line that is already connecting alone", async () => {
    const { machines, reconcile } = reconciler();
    machines.seed({ name: "b", target: meshVia(PROGRAM, STATE, b.hostId), via: true, state: "connecting" });
    await reconcile.presence(b);
    expect(machines.calls).toEqual([]);
  });

  test("presence of a member whose line is down connects it now", async () => {
    const { machines, reconcile } = reconciler();
    machines.seed({ name: "b", target: meshVia(PROGRAM, STATE, b.hostId), via: true, state: "unreachable" });
    await reconcile.presence(b);
    expect(machines.calls).toEqual(["0 connect b"]);
  });

  test("a member whose hostId is malformed is STUCK, and the others are still added", async () => {
    const { machines, reconcile } = reconciler();
    const bad = member("bad", "x$(touch PWN)");
    await reconcile.reconcile(viewOf(bad, c));
    expect(reconcile.status.get(bad.hostId)?.state).toBe("stuck");
    expect(machines.calls).toEqual(["0 add c"]);
  });

  test("a held member is added only once released (the 0-5 s add jitter)", async () => {
    const { machines, reconcile } = reconciler();
    reconcile.holdAdd(c.hostId);
    await reconcile.reconcile(viewOf(c));
    expect(machines.calls).toEqual([]);
    await reconcile.releaseAdd(c.hostId);
    expect(machines.calls).toEqual(["0 add c"]);
  });
});
