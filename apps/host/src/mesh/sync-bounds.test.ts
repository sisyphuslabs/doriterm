import { describe, expect, test } from "bun:test";
import type { MeshMessage } from "./sync-lines.ts";
import { MAX_RECORDS } from "./merge.ts";
import { FakeSigner, fakeRules, hashOfRecord, MESH_ID, meshOf, member } from "./testing/fake-mesh.ts";
import { sessionAtB } from "./testing/scripted.ts";
import type { MeshRecord } from "./upstream.ts";

const junk = (from: number, count: number): readonly MeshRecord[] =>
  Array.from({ length: count }, (_, i) => ({ body: `{"junk":${from + i}}`, sig: "x" }));

const heads = (from: number): readonly string[] => Array.from({ length: 1024 }, (_, i) => `head-${from + i}`);

const recordsIn = (messages: readonly MeshMessage[]): readonly string[] =>
  messages.flatMap((message) => (message.t === "records" ? message.records.map(hashOfRecord) : []));

describe("what one sync session holds for a peer is bounded (abuse, section 5.2)", () => {
  test("records past 4096 before done close the session 4400, and nothing is merged", () => {
    const peer = sessionAtB();
    for (let line = 0; line < 4; line++) peer.receive({ t: "records", records: junk(line * 1024, 1024) });
    expect(peer.closes).toEqual([]);
    peer.receive({ t: "records", records: junk(MAX_RECORDS, 1) });
    peer.receive({ t: "done" });
    expect(peer.closes.map((close) => close.code)).toEqual([4400]);
    expect(peer.batchSizes).toEqual([]);
  });

  test("a peer claiming more than 4096 distinct heads is closed 4400", () => {
    const peer = sessionAtB();
    for (let line = 0; line < 4; line++) peer.receive({ t: "hello", v: 2, mesh: MESH_ID, heads: heads(0), n: {} });
    for (let line = 0; line < 4; line++) {
      peer.receive({ t: "hello", v: 2, mesh: MESH_ID, heads: heads(line * 1024), n: {} });
    }
    expect(peer.closes).toEqual([]);
    peer.receive({ t: "hello", v: 2, mesh: MESH_ID, heads: ["one-too-many"], n: {} });
    expect(peer.closes.map((close) => close.code)).toEqual([4400]);
  });

  test("a want repeated 20 times is answered once: each record goes out once per session", () => {
    const [a, b] = [member("a"), member("b")];
    const records: MeshRecord[] = [...meshOf([a, b])];
    const founder = new FakeSigner(a, 2);
    for (let i = 0; i < 50; i++) records.push(founder.name(fakeRules.headsOf(records), `name${i}`));
    const peer = sessionAtB(records);
    const hashes = records.map(hashOfRecord);
    const before = peer.sent.length;
    peer.receive({ t: "want", hashes });
    const answered = peer.sent.length;
    for (let i = 0; i < 19; i++) peer.receive({ t: "want", hashes });
    expect(recordsIn(peer.sent.slice(before)).toSorted()).toEqual(hashes.toSorted());
    expect(peer.sent.length).toBe(answered);
  });

  test("a hello from another mesh closes the session 4401", () => {
    const peer = sessionAtB();
    peer.receive({ t: "hello", v: 2, mesh: "othermeshothermeshothermes", heads: [], n: {} });
    expect(peer.closes.map((close) => close.code)).toEqual([4401]);
    expect(peer.session.closed).toBe(true);
  });
});
