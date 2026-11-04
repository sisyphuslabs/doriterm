import { describe, expect, test } from "bun:test";
import { hashOf, type Signed } from "@doriface/mesh";
import { hostB, restored } from "./testing/claim-host.ts";
import { headsOfRecords, meshOf, peer, Signer } from "./testing/mesh-peers.ts";

const [a, b, c] = [peer("a"), peer("b"), peer("c")];
const MAX = Number.MAX_SAFE_INTEGER;

describe("an automatic ack a claim holds back (section 10.1)", () => {
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

  test("an ack owed while this host's counter is behind is signed once, by the next merge that acks", async () => {
    const { records, chain } = restored(1);
    const h = hostB(records, 21);
    const session = h.connect();
    session.hello({ [b.signPub]: MAX });
    session.send(new Signer(a, records).admit(peer("d"), headsOfRecords(records)));
    session.done();
    await h.at(1_000);
    h.storeOnly(chain);
    await h.at(30_001);
    expect(h.cooldowns()).toBe(1);
    expect(h.ownNs()).toEqual([1]);
    const fromC = h.connect(c);
    fromC.send(new Signer(c, records).admit(peer("e"), headsOfRecords(h.stored())));
    fromC.done();
    await h.at(31_000);
    expect(h.own()).toEqual([
      { n: 1, type: "ack" },
      { n: 2, type: "ack" },
    ]);
  });
});
