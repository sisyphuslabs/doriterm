import { describe, expect, test } from "bun:test";
import { SecureLinkError } from "@doriface/crypto";
import { MeshRuntime } from "./runtime.ts";
import { FakeClock, seededRandom } from "./testing/fake-clock.ts";
import type { MeshStore } from "../state/mesh.ts";
import { cardFor } from "../testing/mesh-history.ts";
import { meshOf, type Peer, peer, storeOf } from "./testing/mesh-peers.ts";
import { FakeMachines } from "./testing/fake-machines.ts";
import { meshVia } from "./via.ts";

const PROGRAM = "/opt/doriface-host";
const STATE = "/state";
const [a, b] = [peer("a"), peer("b")];
const offline = () => Promise.reject(new SecureLinkError(4404, "host is not connected to the relay (4404)"));

function runtime(): { clock: FakeClock; machines: FakeMachines; mesh: MeshRuntime; store: MeshStore } {
  const clock = new FakeClock();
  const machines = new FakeMachines(clock);
  const { records, meshId } = meshOf([a, b]);
  const store = storeOf(a, records);
  const mesh = new MeshRuntime({
    store,
    identity: a.machine.identity,
    meshId,
    clock,
    random: seededRandom(41),
    dial: offline,
    dialLine: offline,
    machines,
    program: PROGRAM,
    stateDir: STATE,
    log: () => undefined,
  });
  return { clock, machines, mesh, store };
}

/** a admits `joiner` through its own store, as a served join does, and hands the record to sync. */
function admitAs(store: MeshStore, mesh: MeshRuntime, joiner: Peer): void {
  const card = cardFor(joiner.machine, mesh.gossip.meshId, a.machine);
  const record = store.sign(a.machine.identity, (n, prev) => ({
    v: 2,
    mesh: mesh.gossip.meshId,
    type: "admit",
    by: a.signPub,
    n,
    prev,
    subject: { card },
  }));
  mesh.gossip.stored([record]);
}

const timesOf = (calls: readonly string[], call: string): readonly number[] =>
  calls.filter((entry) => entry.endsWith(` ${call}`)).map((entry) => Number(entry.split(" ")[0]));

describe("the running host's mesh wiring (sections 8.1 and 8.2)", () => {
  test("presence of a member whose line is down makes herdr dial it within 0-2 s", async () => {
    const { clock, machines, mesh } = runtime();
    machines.seed({ name: "b", target: meshVia(PROGRAM, STATE, b.hostId), via: true, state: "unreachable" });
    await mesh.start();
    mesh.presence(b.signPub);
    await clock.advance(2_000);
    const connects = timesOf(machines.calls, "connect b");
    expect(connects.length).toBe(1);
    expect(connects[0]).toBeLessThanOrEqual(2_000);
  });

  test("a new admission is added after the 0-5 s jitter, not before", async () => {
    const { clock, machines, mesh, store } = runtime();
    machines.seed({ name: "b", target: meshVia(PROGRAM, STATE, b.hostId), via: true });
    await mesh.start();
    await clock.advance(1_000);
    admitAs(store, mesh, peer("c"));
    await mesh.reconciler.idle();
    expect(timesOf(machines.calls, "add c")).toEqual([]);
    await clock.advance(5_000);
    await mesh.reconciler.idle();
    const adds = timesOf(machines.calls, "add c");
    expect(adds.length).toBe(1);
    expect(adds[0]).toBeGreaterThanOrEqual(1_000);
    expect(adds[0]).toBeLessThanOrEqual(6_000);
    mesh.stop();
  });
});
