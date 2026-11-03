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

const ownNs = (store: MeshStore): readonly number[] =>
  (store.read()?.records ?? []).flatMap((record) => {
    const body = parseRecord(record);
    return body?.by === b.signPub ? [body.n] : [];
  });

/** b restored from a backup older than its own ack n = 1, which a peer still holds. */
function restored() {
  const { records, meshId } = meshOf([a, b]);
  const founder = new Signer(a, records);
  const live = storeOf(b, records);
  const deps = (store: MeshStore) => ({ store, identity: b.machine.identity, meshId });
  const ownAck = mergeBatch(deps(live), [founder.admit(peer("c"), headsOfRecords(records))]).ack;
  if (ownAck === undefined) throw new Error("b wrote no ack before its backup was restored");
  const store = storeOf(b, records);
  return { records, founder, store, deps: deps(store), peerHolds: live.read()?.records ?? [] };
}

describe("a host restored from an older backup (section 10.1)", () => {
  test("merges a membership batch without signing, then catches its counter up and acks the next as n = 2", () => {
    const { store, deps, founder, peerHolds } = restored();
    const first = mergeBatch(deps, peerHolds.slice(2));
    expect(first.counterBehind).toBe(true);
    expect(first.ack).toBeUndefined();
    expect(store.read()?.records.length).toBe(peerHolds.length);
    const next = mergeBatch(deps, [founder.admit(peer("d"), headsOfRecords(peerHolds))]);
    expect(next.ack).toBeDefined();
    expect(ownNs(store)).toEqual([1, 2]);
  });

  test("an own record (a revoke, a leave) is refused while behind, and nothing is stored", () => {
    const { store, deps, peerHolds } = restored();
    const revoke = { type: "revoke", signPubs: [a.signPub], reason: "revoke" } as const;
    store.transact((tx) => void tx.merge(peerHolds.slice(2)));
    expect(() => appendOwn(deps, revoke)).toThrow(CounterBehindError);
    expect(store.read()?.records.length).toBe(peerHolds.length);
  });

  test("a peer's hello claiming n = 2^53 for this host does not silence it: the next admit is acked", async () => {
    const clock = new FakeClock();
    const net = new MeshNet(clock, seededRandom(29));
    const { records } = meshOf([a, b]);
    const host = net.add(b, records);
    const [ours, theirs] = memoryLinkPair(true);
    host.gossip.attach(a.signPub, a.signPub, ours);
    const send = (line: MeshLine): void => theirs.send(new TextEncoder().encode(`${JSON.stringify(line)}\n`));
    const claim = { [b.signPub]: Number.MAX_SAFE_INTEGER };
    send({ t: "hello", v: 2, mesh: host.gossip.meshId, heads: headsOfRecords(records), n: claim });
    send({ t: "records", records: [new Signer(a, records).admit(peer("c"), headsOfRecords(records))] });
    send({ t: "done", mesh: host.gossip.meshId });
    await settle();
    expect(acksBy(host.store, b.signPub)).toBe(1);
  });

  test("between a peer's hello and its records, an own record waits for the counter the hello claims (section 10.1)", async () => {
    const { records, peerHolds } = restored();
    const clock = new FakeClock();
    const net = new MeshNet(clock, seededRandom(43));
    const host = net.add(b, records);
    const [ours, theirs] = memoryLinkPair(true);
    host.gossip.attach(a.signPub, a.signPub, ours);
    const send = (line: MeshLine): void => theirs.send(new TextEncoder().encode(`${JSON.stringify(line)}\n`));
    send({ t: "hello", v: 2, mesh: host.gossip.meshId, heads: headsOfRecords(peerHolds), n: { [b.signPub]: 1 } });
    await settle();
    const revoke = { type: "revoke", signPubs: [a.signPub], reason: "revoke" } as const;
    expect(() => host.gossip.append(revoke)).toThrow(CounterBehindError);
    send({ t: "records", records: peerHolds.slice(2) });
    send({ t: "done", mesh: host.gossip.meshId });
    await settle();
    host.gossip.append(revoke);
    expect(ownNs(host.store)).toEqual([1, 2]);
  });
});
