import { describe, expect, test } from "bun:test";
import { hashOf, MAX_RECORDS, type Signed } from "@doriface/mesh";
import type { MeshLine } from "./lines.ts";
import { headsOfRecords, meshOf, peer, Signer } from "./testing/mesh-peers.ts";
import { sessionAtB } from "./testing/scripted.ts";

const junk = (from: number, count: number): readonly Signed[] =>
  Array.from({ length: count }, (_, i) => ({ body: `{"junk":${from + i}}`, sig: "x" }));

const heads = (from: number): readonly string[] => Array.from({ length: 1024 }, (_, i) => `head-${from + i}`);

const recordsIn = (lines: readonly MeshLine[]): readonly string[] =>
  lines.flatMap((line) => (line.t === "records" ? line.records.map(hashOf) : []));

describe("what one sync session holds for a peer is bounded (abuse, section 5.2)", () => {
  test("records past 4096 before done close the session 4400, and nothing is merged", async () => {
    const peerA = sessionAtB();
    for (let line = 0; line < 4; line++) peerA.receive({ t: "records", records: junk(line * 1024, 1024) });
    await peerA.settled();
    expect(peerA.closedWith()).toBeUndefined();
    peerA.receive({ t: "records", records: junk(MAX_RECORDS, 1) });
    await peerA.settled();
    expect(peerA.closedWith()).toBe(4400);
    expect(peerA.batchSizes).toEqual([]);
  });

  test("a peer claiming more than 4096 distinct heads is closed 4400", async () => {
    const peerA = sessionAtB();
    const hello = (claimed: readonly string[]): MeshLine => ({
      t: "hello",
      v: 2,
      mesh: peerA.meshId,
      heads: claimed,
      n: {},
    });
    for (let line = 0; line < 4; line++) peerA.receive(hello(heads(0)));
    for (let line = 0; line < 4; line++) peerA.receive(hello(heads(line * 1024)));
    await peerA.settled();
    expect(peerA.closedWith()).toBeUndefined();
    peerA.receive(hello(["one-too-many"]));
    await peerA.settled();
    expect(peerA.closedWith()).toBe(4400);
  });

  test("a want repeated 20 times is answered once: each record goes out once per session", async () => {
    const [a, b] = [peer("a"), peer("b")];
    const records: Signed[] = [...meshOf([a, b]).records];
    const founder = new Signer(a, records);
    for (let i = 0; i < 30; i++) records.push(founder.name(headsOfRecords(records), `name${i}`));
    const peerA = sessionAtB(records);
    const hashes = records.map(hashOf);
    const before = peerA.sent.length;
    for (let i = 0; i < 20; i++) peerA.receive({ t: "want", hashes });
    await peerA.settled();
    expect(recordsIn(peerA.sent.slice(before)).toSorted()).toEqual(hashes.toSorted());
  });

  test("a hello from another mesh is refused, then closed 4401", async () => {
    const peerA = sessionAtB();
    peerA.receive({ t: "hello", v: 2, mesh: "othermeshothermeshothermes", heads: [], n: {} });
    await peerA.settled();
    expect(peerA.sent.at(-1)?.t).toBe("refused");
    expect(peerA.closedWith()).toBe(4401);
    expect(peerA.session.closed).toBe(true);
  });
});
