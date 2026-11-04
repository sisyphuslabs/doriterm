import { describe, expect, test } from "bun:test";
import { hashOf } from "@doriface/mesh";
import { hostB, restored } from "./testing/claim-host.ts";
import { headsOfRecords, meshOf, peer, Signer } from "./testing/mesh-peers.ts";

const [a, b, c] = [peer("a"), peer("b"), peer("c")];
const MAX = Number.MAX_SAFE_INTEGER;

describe("a claim's 30 s run on only while its claimer delivers this host's own records (section 10.1)", () => {
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
