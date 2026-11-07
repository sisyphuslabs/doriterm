import { describe, expect, test } from "bun:test";
import { hashOf, type Signed, viewOf } from "@doriface/mesh";
import { AuthorizeIndex, indexOf } from "../mesh/authorize-index.ts";
import { meshOf, type Peer, peer, Signer, storeOf } from "../mesh/testing/mesh-peers.ts";
import type { MeshStore } from "./mesh.ts";
import { headsOf } from "./mesh-tx.ts";

// Differential (#567): the index written with each counter b persists, carried over its own acks or rebuilt, against a
// fresh evaluation of the records written with it. The view itself is checked against the naive oracle in
// packages/mesh/test; here the host's full rebuild (viewOf, then indexOf) is the reference.

const [a, b, c, d, f, e] = [peer("a"), peer("b"), peer("c"), peer("d"), peer("f"), peer("e")];
const self = b.signPub;

/** Every authorize decision for these keys, as a handshake and the cleanup would ask them. */
function decisions(index: AuthorizeIndex, peers: readonly Peer[]) {
  return peers.map((p) => ({
    member: index.member(p.noisePub)?.signPub,
    device: index.deviceRefusal(p.devicePub ?? ""),
    claims: index.claimsKey(p.noisePub),
    isMember: index.isMember(p.signPub),
    hcId: index.isMemberHcId(p.hcId),
    count: index.memberCount,
  }));
}

/** The index on disk is current and equals a full rebuild of the records on disk, decision for decision. */
function expectRebuilt(store: MeshStore, peers: readonly Peer[]): void {
  const file = store.read();
  if (file === undefined) throw new Error("no mesh.json");
  const full = indexOf(file.records, viewOf(file.records), file.generation);
  expect(file.index?.generation).toBe(file.generation);
  expect(file.index).toEqual(full);
  if (file.index === undefined) return;
  expect(decisions(new AuthorizeIndex(file.index), peers)).toEqual(decisions(new AuthorizeIndex(full), peers));
}

/** Signs b's own acks in one transaction after merging `batch`, each on the heads `pick` chooses; checked after each. */
function ownAcks(
  store: MeshStore,
  meshId: string,
  batch: readonly Signed[],
  picks: readonly ((heads: readonly string[]) => readonly string[])[],
  peers: readonly Peer[],
): void {
  store.transact((tx) => {
    tx.merge(batch);
    for (const pick of picks) {
      tx.sign(b.machine.identity, (n, heads) => ({ v: 2, mesh: meshId, type: "ack", by: self, n, prev: pick(heads) }));
      expectRebuilt(store, peers);
    }
  });
  expectRebuilt(store, peers);
}

const all = (heads: readonly string[]): readonly string[] => heads;
const only =
  (record: Signed) =>
  (heads: readonly string[]): readonly string[] =>
    heads.includes(hashOf(record)) ? [hashOf(record)] : heads;

describe("an own ack the index is carried over is one a full evaluation leaves as it is (#567)", () => {
  test("b's ack that saw c's admission and not a's concurrent revoke of c makes e a member", () => {
    const { records, meshId } = meshOf([a, b, c, d, f]);
    const store = storeOf(b, records);
    const heads = headsOf(records);
    const revoke = new Signer(a, records).revoke(heads, c);
    const admit = new Signer(c, records).admit(e, heads);
    ownAcks(store, meshId, [revoke, admit], [only(admit), all], [a, b, c, d, f, e]);
    expect(viewOf(store.read()?.records ?? []).members.has(e.signPub)).toBe(true);
  });

  test("b's ack that saw a's revoke of c and not c's concurrent admission keeps e out, against d's testimony", () => {
    const { records, meshId } = meshOf([a, b, c, d, f]);
    const store = storeOf(b, records);
    const heads = headsOf(records);
    const revoke = new Signer(a, records).revoke(heads, c);
    const admit = new Signer(c, records).admit(e, heads);
    const sawAdmit = new Signer(d, records).ack([hashOf(admit)]);
    const sawRevoke = new Signer(f, records).ack([hashOf(revoke)]);
    const batch = [revoke, admit, sawAdmit, sawRevoke];
    expect(viewOf([...records, ...batch]).members.has(e.signPub)).toBe(true);
    ownAcks(store, meshId, batch, [only(sawRevoke), all], [a, b, c, d, f, e]);
    expect(viewOf(store.read()?.records ?? []).members.has(e.signPub)).toBe(false);
  });
});

/** A small seeded generator (mulberry32), so a failing case can be run again. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const bases = new Map<string, ReturnType<typeof meshOf>>();
const baseOf = (peers: readonly Peer[]) => {
  const key = peers.map((p) => p.name).join(",");
  const known = bases.get(key) ?? meshOf(peers);
  bases.set(key, known);
  return known;
};

interface Tally {
  carried: number;
  rebuilt: number;
}

/**
 * Three transactions of random records by the other members (acks, names, revokes, admissions, on random subsets of the
 * latest records), each followed by one to four acks of b's on random subsets of the heads, every write checked.
 */
function scenario(seed: number, members: readonly Peer[], tally: Tally): void {
  const next = random(seed);
  const pickOf = <T>(items: readonly T[]): T => {
    const item = items[Math.floor(next() * items.length)];
    if (item === undefined) throw new Error("nothing to pick");
    return item;
  };
  const subset = (heads: readonly string[]): readonly string[] => {
    if (next() < 0.3) return heads;
    const chosen = heads.filter(() => next() < 0.4);
    return chosen.length > 0 ? chosen : [pickOf(heads)];
  };
  const { records, meshId } = baseOf(members);
  let evaluations = 0;
  const store = storeOf(b, records, {
    evaluate: (set) => {
      evaluations += 1;
      return viewOf(set);
    },
  });
  const others = members.filter((p) => p !== b);
  const signers = new Map(others.map((p) => [p, new Signer(p, records)]));
  const joiners = Array.from({ length: 4 }, (_, i) => peer(`j${seed}-${i}`));
  const everyone = [...members, ...joiners];
  const known: Signed[] = [...records];
  for (let round = 0; round < 3; round++) {
    const batch: Signed[] = [];
    for (let i = Math.floor(next() * 5) + 1; i > 0; i--) {
      const by = pickOf(others);
      const signer = signers.get(by);
      if (signer === undefined) throw new Error("no signer");
      // Recent records, not only the heads, so the history branches and records are concurrent with each other.
      const prev = subset(known.slice(-6).map(hashOf));
      const roll = next();
      const record =
        roll < 0.35
          ? signer.ack(prev)
          : roll < 0.6
            ? signer.revoke(prev, pickOf(everyone.filter((p) => p !== by)))
            : roll < 0.8
              ? signer.admit(pickOf(joiners), prev)
              : signer.name(prev, `n${seed}r${round}i${i}`);
      batch.push(record);
      known.push(record);
    }
    const acks = Array.from({ length: Math.floor(next() * 4) + 1 }, () => subset);
    let before = evaluations;
    store.transact((tx) => {
      tx.merge(batch);
      for (const [i, pick] of acks.entries()) {
        tx.sign(b.machine.identity, (n, heads) => ({
          v: 2,
          mesh: meshId,
          type: "ack",
          by: self,
          n,
          prev: pick(heads),
        }));
        if (i > 0) {
          if (evaluations === before) tally.carried += 1;
          else tally.rebuilt += 1;
        }
        before = evaluations;
        expectRebuilt(store, everyone);
      }
    });
    expectRebuilt(store, everyone);
    known.splice(0, known.length, ...(store.read()?.records ?? []));
  }
}

describe("random histories with revokes and admissions: the index written with each own ack is a full rebuild's", () => {
  const tally: Tally = { carried: 0, rebuilt: 0 };
  const five = [a, b, c, d, f];
  const thirteen = [peer("m0"), b, ...Array.from({ length: 11 }, (_, i) => peer(`m${i + 1}`))];

  test.each([0, 1, 2, 3, 4])(
    "five members, ten seeds from %i * 10",
    (group) => {
      for (let seed = group * 10; seed < group * 10 + 10; seed++) scenario(seed, five, tally);
    },
    60_000,
  );

  test.each([0, 1])(
    "thirteen members, five seeds from 1000 + %i * 5",
    (group) => {
      for (let seed = 1000 + group * 5; seed < 1000 + group * 5 + 5; seed++) {
        scenario(seed, thirteen, tally);
      }
    },
    60_000,
  );

  test("both paths ran: acks the index was carried over and acks it was rebuilt for", () => {
    console.log(`own acks after the first: ${tally.carried} carried, ${tally.rebuilt} rebuilt`);
    expect(tally.carried).toBeGreaterThan(0);
    expect(tally.rebuilt).toBeGreaterThan(0);
  });
});
