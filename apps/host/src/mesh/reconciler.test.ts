import { describe, expect, test } from "bun:test";
import { LIVE_LINES_MS, Reconciler } from "./reconciler.ts";
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

const budget = () => hcError("unreachable", "doriface-host connect: waiting for the dial budget");

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

  test("a budget refusal is retried on the budget's event alone: no timer and no other reconcile (#1433, #1470)", async () => {
    const { clock, machines, reconcile } = reconciler();
    machines.failAdds.set("b", [budget(), budget()]);
    await reconcile.reconcile(viewOf(b));
    await reconcile.reconcile(viewOf(b));
    await clock.advance(30 * 60_000);
    await reconcile.idle();
    expect(machines.calls).toEqual(["0 add b"]);
    await reconcile.budgetAvailable(b.hostId);
    await reconcile.idle();
    await reconcile.reconcile(viewOf(b));
    expect(machines.calls).toEqual(["0 add b", "1800000 add b"]);
    await reconcile.budgetAvailable(b.hostId);
    await reconcile.idle();
    expect(machines.calls).toEqual(["0 add b", "1800000 add b", "1800000 add b"]);
    expect(reconcile.status.get(b.hostId)?.state).toBe("ok");
  });

  test("a budget refusal after an unreachable one is retried on the budget's event, not the doubled backoff (#1470)", async () => {
    const { clock, machines, reconcile } = reconciler();
    machines.failAdds.set("b", [hcError("unreachable"), budget()]);
    await reconcile.reconcile(viewOf(b));
    await clock.advance(30_000);
    await reconcile.idle();
    expect(machines.calls).toEqual(["0 add b", "30000 add b"]);
    await clock.advance(1_000);
    await reconcile.budgetAvailable(b.hostId);
    await reconcile.idle();
    expect(machines.calls).toEqual(["0 add b", "30000 add b", "31000 add b"]);
    expect(reconcile.status.get(b.hostId)?.state).toBe("ok");
  });

  test("presence of a member with no machine entry adds it at once; a view change alone waits (#1470)", async () => {
    const { clock, machines, reconcile } = reconciler();
    machines.failAdds.set("b", [hcError("unreachable"), hcError("unreachable")]);
    await reconcile.reconcile(viewOf(b));
    await clock.advance(1_000);
    await reconcile.reconcile(viewOf(b));
    expect(machines.calls).toEqual(["0 add b"]);
    await reconcile.presence(b);
    await reconcile.idle();
    expect(machines.calls).toEqual(["0 add b", "1000 add b"]);
    // Still refused: the backoff keeps doubling from the attempts made, presence or not.
    await clock.advance(59_999);
    await reconcile.idle();
    expect(machines.calls).toEqual(["0 add b", "1000 add b"]);
    await clock.advance(1);
    await reconcile.idle();
    expect(machines.calls).toEqual(["0 add b", "1000 add b", "61000 add b"]);
    expect((await machines.list()).map((machine) => machine.name)).toEqual(["b"]);
  });

  test("presence arriving while the refused add is in flight retries it once the refusal lands (#1470)", async () => {
    const { machines, reconcile } = reconciler();
    machines.failAdds.set("b", [hcError("unreachable")]);
    const add = machines.add.bind(machines);
    let present = false;
    machines.add = (name, via) => {
      if (!present) {
        present = true;
        void reconcile.presence(b);
      }
      return add(name, via);
    };
    await reconcile.reconcile(viewOf(b));
    await reconcile.idle();
    await reconcile.idle();
    expect(machines.calls).toEqual(["0 add b", "0 add b"]);
    expect(reconcile.status.get(b.hostId)?.state).toBe("ok");
  });

  test("presence does not release an add refused for the dial budget: only the budget's event does (#1470)", async () => {
    const { clock, machines, reconcile } = reconciler();
    machines.failAdds.set("b", [budget()]);
    await reconcile.reconcile(viewOf(b));
    await reconcile.presence(b);
    await clock.advance(30_000);
    await reconcile.idle();
    expect(machines.calls).toEqual(["0 add b"]);
    await reconcile.budgetAvailable(b.hostId);
    await reconcile.idle();
    expect(machines.calls).toEqual(["0 add b", "30000 add b"]);
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

  test("another member's retry never releases a budget-refused member (#1433)", async () => {
    const { clock, machines, reconcile } = reconciler();
    machines.failAdds.set("b", [budget(), budget()]);
    machines.failAdds.set("c", [hcError("unreachable"), hcError("unreachable")]);
    await reconcile.reconcile(viewOf(b, c));
    await clock.advance(90_000);
    await reconcile.idle();
    expect(machines.calls.filter((call) => call.endsWith("add b"))).toEqual(["0 add b"]);
    expect(machines.calls.filter((call) => call.endsWith("add c"))).toEqual(["0 add c", "30000 add c", "90000 add c"]);
    await reconcile.budgetAvailable(b.hostId);
    await clock.advance(600_000);
    await reconcile.idle();
    expect(machines.calls.filter((call) => call.endsWith("add b"))).toEqual(["0 add b", "90000 add b"]);
    await reconcile.budgetAvailable(b.hostId);
    expect(machines.calls.filter((call) => call.endsWith("add b"))).toEqual(["0 add b", "90000 add b", "690000 add b"]);
  });

  test("a budget wake arriving before the refused add settles is kept: the add is retried once it lands (#1433, #1470)", async () => {
    const { machines, reconcile } = reconciler();
    machines.failAdds.set("b", [budget()]);
    const add = machines.add.bind(machines);
    let notified = false;
    machines.add = (name, via) => {
      if (!notified) {
        notified = true;
        void reconcile.budgetAvailable(b.hostId);
      }
      return add(name, via);
    };
    await reconcile.reconcile(viewOf(b));
    await reconcile.idle();
    await reconcile.idle();
    expect(machines.calls).toEqual(["0 add b", "0 add b"]);
    expect(reconcile.status.get(b.hostId)?.state).toBe("ok");
  });
});

describe("this host's own membership (section 6.4)", () => {
  test("a host its own view lists as revoked removes every mesh machine, keeps the owner's own, and adds them back once a member again", async () => {
    const outside: MeshView = { members: [b, c], revoked: [self.signPub] };
    const { machines, reconcile } = reconciler();
    machines.seed({ name: "laptop", target: "ssh://laptop" });
    await reconcile.reconcile(viewOf(b, c));
    await reconcile.reconcile(outside);
    expect((await machines.list()).map((machine) => machine.name)).toEqual(["laptop"]);
    await reconcile.reconcile(viewOf(b, c));
    expect(machines.calls).toEqual(["0 add b", "0 add c", "0 rm b", "0 rm c", "0 add b", "0 add c"]);
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

const stateOf = (reconcile: Reconciler, name: string): string | undefined =>
  reconcile.lines().find((entry) => entry.machine.name === name)?.machine.state;

describe("the line state status reads (#754)", () => {
  test("a line herdr connected after the last reconcile reads connected once status refreshes", async () => {
    const { machines, reconcile } = reconciler();
    machines.addState = "connecting";
    await reconcile.reconcile(viewOf(b));
    expect(stateOf(reconcile, "b")).toBe("connecting");
    machines.setState("b", "connected");
    await reconcile.refreshLines();
    expect(stateOf(reconcile, "b")).toBe("connected");
  });

  test("a herdr that does not answer within the budget leaves the last list, and the read ends at the budget", async () => {
    const { clock, machines, reconcile } = reconciler();
    machines.addState = "connecting";
    await reconcile.reconcile(viewOf(b));
    machines.stallLists = true;
    let done = false;
    const refreshed = reconcile.refreshLines().finally(() => {
      done = true;
    });
    await clock.advance(LIVE_LINES_MS - 1);
    expect(done).toBe(false);
    await clock.advance(1);
    await refreshed;
    expect(stateOf(reconcile, "b")).toBe("connecting");
  });

  test("a refresh that answers after a newer reconcile never puts the older list back", async () => {
    const { machines, reconcile } = reconciler();
    machines.addState = "connecting";
    await reconcile.reconcile(viewOf(b));
    const release = machines.holdNextList();
    const refreshed = reconcile.refreshLines();
    machines.setState("b", "connected");
    await reconcile.reconcile(viewOf(b));
    expect(stateOf(reconcile, "b")).toBe("connected");
    release();
    await refreshed;
    expect(stateOf(reconcile, "b")).toBe("connected");
  });
});
