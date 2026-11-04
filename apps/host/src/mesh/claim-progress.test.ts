import { describe, expect, test } from "bun:test";
import { memoryLinkPair } from "@doriface/crypto/testing";
import { hashOf, parseRecord, type Signed } from "@doriface/mesh";
import { CounterBehindError } from "../state/mesh.ts";
import { DialPolicy } from "./dial-policy.ts";
import { Gossip } from "./gossip.ts";
import type { MeshLine } from "./lines.ts";
import { FakeClock, seededRandom } from "./testing/fake-clock.ts";
import { headsOfRecords, meshIdOfRecords, meshOf, peer, type Peer, Signer, storeOf } from "./testing/mesh-peers.ts";

const [a, b, c] = [peer("a"), peer("b"), peer("c")];
const MAX = Number.MAX_SAFE_INTEGER;
const COOLDOWN = "ignored for 10 minutes";

/** b holding `records`, with its log; `connect(from)` opens a session `from` dialed to b, and the test speaks for it. */
function hostB(records: readonly Signed[], seed: number) {
  const clock = new FakeClock();
  const logs: string[] = [];
  const store = storeOf(b, records);
  const meshId = meshIdOfRecords(records);
  const gossip = new Gossip({
    store,
    identity: b.machine.identity,
    meshId,
    clock,
    random: seededRandom(seed),
    policy: new DialPolicy({ clock, random: seededRandom(seed + 1), onDue: () => undefined }),
    dial: () => Promise.reject(new Error("b dials nobody here")),
    log: (line) => void logs.push(line),
  });
  const stored = (): readonly Signed[] => store.read()?.records ?? [];
  const connect = (from: Peer = a, heads: readonly string[] = headsOfRecords(stored())) => {
    const [ours, theirs] = memoryLinkPair(true);
    gossip.attach(from.signPub, from.signPub, ours);
    const say = (line: MeshLine): void => theirs.send(new TextEncoder().encode(`${JSON.stringify(line)}\n`));
    return {
      hello: (n: Readonly<Record<string, number>>) => say({ t: "hello", v: 2, mesh: meshId, heads, n }),
      send: (...sent: readonly Signed[]) => say({ t: "records", records: sent }),
      done: () => say({ t: "done", mesh: meshId }),
    };
  };
  let renames = 0;
  const signs = (): boolean => {
    try {
      gossip.append({ type: "name", signPub: b.signPub, name: `b${(renames += 1)}` });
      return true;
    } catch (error) {
      if (error instanceof CounterBehindError) return false;
      throw error;
    }
  };
  const own = (): readonly { readonly n: number; readonly type: string }[] =>
    stored().flatMap((record) => {
      const body = parseRecord(record);
      return body?.by === b.signPub ? [{ n: body.n, type: body.type }] : [];
    });
  const ownNs = (): readonly number[] => own().map((record) => record.n);
  const cooldowns = (): number => logs.filter((line) => line.includes(COOLDOWN)).length;
  const at = async (ms: number): Promise<void> => clock.advance(ms - clock.now());
  return { gossip, stored, connect, signs, own, ownNs, cooldowns, at };
}

/** b restored from a backup taken before its own records `1..count`: a holds them, each acking the one before. */
function restored(count: number) {
  const { records } = meshOf([a, b, c]);
  const signer = new Signer(b, records);
  const chain: Signed[] = [];
  for (let i = 0; i < count; i++) {
    const last = chain.at(-1);
    chain.push(signer.ack(last === undefined ? headsOfRecords(records) : [hashOf(last)]));
  }
  return { records, chain, heads: headsOfRecords([...records, ...chain]) };
}

describe("a claim's 30 s run on only while its claimer delivers this host's own records (section 10.1)", () => {
  test("b holds its automatic ack back while a claim stands, and signs it when the claim expires", async () => {
    const { records } = meshOf([a, b, c]);
    const h = hostB(records, 11);
    const signer = new Signer(a, records);
    const session = h.connect();
    session.hello({ [b.signPub]: MAX });
    const before = h.ownNs().length;
    await h.at(5_000);
    session.send(signer.admit(peer("d"), headsOfRecords(h.stored())));
    session.done();
    await h.at(25_000);
    session.send(signer.admit(peer("e"), headsOfRecords(h.stored())));
    session.done();
    await h.at(29_999);
    expect(h.ownNs().length).toBe(before);
    expect(h.signs()).toBe(false);
    await h.at(30_001);
    expect(h.cooldowns()).toBe(1);
    expect(
      h
        .own()
        .slice(before)
        .map((record) => record.type),
    ).toEqual(["ack"]);
  });

  // The held ack (for d's admit) is signed as n = 2 the moment the claim resolves; an admit after it gets its own ack.
  test.each<[string, (signer: Signer, prev: readonly string[]) => Signed, readonly number[]]>([
    ["a record it does not ack", (signer, prev) => signer.name(prev, "a2"), [1, 2]],
    ["a record it acks itself", (signer, prev) => signer.admit(peer("e"), prev), [1, 2, 3]],
  ])(
    "an ack held back is signed once after the claimed records resolve the claim and %s arrives: no fork",
    async (_how, next, acks) => {
      const { records, chain, heads } = restored(1);
      const signer = new Signer(a, records);
      const admit = signer.admit(peer("d"), headsOfRecords(records));
      const h = hostB(records, 12);
      const session = h.connect(a, heads);
      session.hello({ [b.signPub]: 1 });
      await h.at(1_000);
      session.send(admit);
      session.done();
      await h.at(2_000);
      expect(h.ownNs()).toEqual([]);
      session.send(...chain);
      session.done();
      await h.at(3_000);
      expect(h.own()).toEqual([
        { n: 1, type: "ack" },
        { n: 2, type: "ack" },
      ]);
      session.send(next(signer, [hashOf(admit)]));
      session.done();
      await h.at(4_000);
      expect(h.own()).toEqual(acks.map((n) => ({ n, type: "ack" })));
      expect(h.cooldowns()).toBe(0);
    },
  );

  test("a claimer that delivers is resolved: it is logged nowhere, and its next claim is heard", async () => {
    const { records, chain, heads } = restored(1);
    const h = hostB(records, 13);
    const session = h.connect(a, heads);
    session.hello({ [b.signPub]: 1 });
    await h.at(10_000);
    session.send(new Signer(a, records).admit(peer("d"), headsOfRecords(records)), ...chain);
    session.done();
    await h.at(60_000);
    expect(h.cooldowns()).toBe(0);
    session.hello({ [b.signPub]: MAX });
    await h.at(60_001);
    expect(h.signs()).toBe(false);
  });

  test("a claimer whose claim lapsed is ignored for 10 minutes, then heard again", async () => {
    const h = hostB(meshOf([a, b, c]).records, 19);
    const claim = async (time: number): Promise<boolean> => {
      await h.at(time);
      h.connect().hello({ [b.signPub]: MAX });
      await h.at(time + 1);
      return h.signs();
    };
    expect(await claim(0)).toBe(false);
    await h.at(30_001);
    expect(h.cooldowns()).toBe(1);
    expect(await claim(331_000)).toBe(true);
    expect(await claim(631_000)).toBe(false);
  });

  test("a hello claiming no more than this host's counter holds nothing and ignores nobody", async () => {
    const h = hostB(meshOf([a, b, c]).records, 14);
    const session = h.connect();
    session.hello({});
    session.hello({ [b.signPub]: Math.max(0, ...h.ownNs()) });
    session.done();
    await h.at(1);
    expect(h.signs()).toBe(true);
    await h.at(31_000);
    expect(h.cooldowns()).toBe(0);
    session.hello({ [b.signPub]: MAX });
    await h.at(31_001);
    expect(h.signs()).toBe(false);
  });

  test("each record the claimer delivers below the claim renews its 30 s, so a slow restore is not cut", async () => {
    const { records, chain, heads } = restored(3);
    const h = hostB(records, 15);
    const session = h.connect(a, heads);
    session.hello({ [b.signPub]: 3 });
    const [first, second, third] = chain;
    if (first === undefined || second === undefined || third === undefined) throw new Error("no chain");
    await h.at(20_000);
    session.send(first);
    await h.at(45_000);
    session.send(second);
    await h.at(70_000);
    session.send(third);
    session.done();
    await h.at(75_000);
    expect(h.cooldowns()).toBe(0);
    expect(h.ownNs()).toEqual([1, 2, 3]);
  });

  test("a steady honest restore never forks: b signs nothing until its last own record arrives", async () => {
    const steps = 6;
    const { records, chain, heads } = restored(steps);
    const signer = new Signer(a, records);
    const h = hostB(records, 16);
    const session = h.connect(a, heads);
    session.hello({ [b.signPub]: steps });
    const signedEarly: number[] = [];
    const step = async (time: number): Promise<void> => {
      if (time > steps * 25_000 + 10_000) return;
      await h.at(time);
      const k = time / 25_000;
      const record = Number.isInteger(k) ? chain[k - 1] : undefined;
      if (record !== undefined) {
        // Each line brings an admit too, so only the claim keeps b from acking it on a stale counter.
        session.send(record, signer.admit(peer(`x${k}`), [hashOf(record)]));
        session.done();
        await h.at(time + 1);
      } else if (time < steps * 25_000 && h.signs()) signedEarly.push(time);
      return step(time + 5_000);
    };
    await step(5_000);
    const ns = h.ownNs();
    expect(signedEarly).toEqual([]);
    expect(h.cooldowns()).toBe(0);
    expect(ns.slice(0, steps)).toEqual(Array.from({ length: steps }, (_, i) => i + 1));
    expect(new Set(ns).size).toBe(ns.length);
  });

  test("this host's own records that another member delivers renew no claim, nor the claimer's next records", async () => {
    const { records, chain, heads } = restored(2);
    const h = hostB(records, 17);
    const fromA = h.connect(a, heads);
    fromA.hello({ [b.signPub]: 2 });
    await h.at(20_000);
    const fromC = h.connect(c, heads);
    fromC.send(...chain.slice(0, 1));
    fromC.done();
    await h.at(25_000);
    fromA.send(new Signer(a, records).admit(peer("d"), headsOfRecords(records)));
    fromA.done();
    await h.at(30_001);
    expect(h.cooldowns()).toBe(1);
  });

  test("a stopped host's claims expire nowhere", async () => {
    const h = hostB(meshOf([a, b, c]).records, 18);
    h.connect().hello({ [b.signPub]: MAX });
    await h.at(1_000);
    h.gossip.stop();
    await h.at(31_000);
    expect(h.cooldowns()).toBe(0);
  });
});
