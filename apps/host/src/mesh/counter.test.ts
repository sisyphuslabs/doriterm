import { describe, expect, test } from "bun:test";
import { memoryLinkPair } from "@doriface/crypto/testing";
import { parseRecord } from "@doriface/mesh";
import { CounterBehindError, type MeshStore } from "../state/mesh.ts";
import type { MeshLine } from "./lines.ts";
import { appendOwn, mergeBatch } from "./merge.ts";
import { FakeClock, seededRandom, settle } from "./testing/fake-clock.ts";
import { headsOfRecords, meshOf, peer, Signer, storeOf } from "./testing/mesh-peers.ts";
import { MeshNet } from "./testing/mesh-net.ts";

const [a, b] = [peer("a"), peer("b")];
const acksBy = (store: MeshStore, who: string): number =>
  (store.read()?.records ?? []).filter((record) => {
    const body = parseRecord(record);
    return body?.type === "ack" && body.by === who;
  }).length;

function behind() {
  const { records, meshId } = meshOf([a, b]);
  const store = storeOf(b, records);
  return { records, store, deps: { store, identity: b.machine.identity, meshId, counterFloor: 4 } };
}

describe("a counter behind what peers hold of this host's records signs nothing (section 10.1)", () => {
  test("a merge with a peer's hello.n above this host's own records writes no ack", () => {
    const { records, store, deps } = behind();
    const admit = new Signer(a, records).admit(peer("c"), headsOfRecords(records));
    const result = mergeBatch(deps, [admit]);
    expect(result.added).toEqual([admit]);
    expect(result.ack).toBeUndefined();
    expect(result.counterBehind).toBe(true);
    expect(acksBy(store, b.signPub)).toBe(0);
  });

  test("an own record (a revoke, a leave) is refused while behind", () => {
    const { records, store, deps } = behind();
    const revoke = { type: "revoke", signPubs: [a.signPub], reason: "revoke" } as const;
    expect(() => appendOwn(deps, revoke)).toThrow(CounterBehindError);
    expect(store.read()?.records.length).toBe(records.length);
  });

  test("a sync session's hello.n sets the floor below which the host signs nothing", async () => {
    const clock = new FakeClock();
    const net = new MeshNet(clock, seededRandom(29));
    const { records } = meshOf([a, b]);
    const host = net.add(b, records);
    const [ours, theirs] = memoryLinkPair(true);
    host.gossip.attach(a.signPub, a.signPub, ours);
    const send = (line: MeshLine): void => theirs.send(new TextEncoder().encode(`${JSON.stringify(line)}\n`));
    send({ t: "hello", v: 2, mesh: host.gossip.meshId, heads: headsOfRecords(records), n: { [b.signPub]: 6 } });
    send({ t: "records", records: [new Signer(a, records).admit(peer("c"), headsOfRecords(records))] });
    send({ t: "done", mesh: host.gossip.meshId });
    await settle();
    expect(acksBy(host.store, b.signPub)).toBe(0);
    expect(() => host.gossip.append({ type: "revoke", signPubs: [b.signPub], reason: "leave" })).toThrow(
      CounterBehindError,
    );
  });
});
