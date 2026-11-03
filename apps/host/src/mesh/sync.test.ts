import { describe, expect, test } from "bun:test";
import { hashOf, type Signed } from "@doriface/mesh";
import { MAX_LINE_BYTES } from "./lines.ts";
import { headsOfRecords, meshOf, peer, Signer } from "./testing/mesh-peers.ts";
import { sessionAtB } from "./testing/scripted.ts";

describe("a sync session (S-1)", () => {
  test("asks once per session for a dangling record's past, and stores both when it comes", async () => {
    const [a, b] = [peer("a"), peer("b")];
    const { records } = meshOf([a, b]);
    const peerA = sessionAtB(records);
    const founder = new Signer(a, records);
    const parent = founder.admit(peer("c"), headsOfRecords(records));
    const child = founder.admit(peer("e"), [hashOf(parent)]);
    for (let i = 0; i < 2; i++) {
      peerA.receive({ t: "records", records: [child] });
      peerA.receive({ t: "done", mesh: peerA.meshId });
    }
    await peerA.settled();
    expect(peerA.sent.filter((line) => line.t === "want")).toEqual([{ t: "want", hashes: [hashOf(parent)] }]);
    peerA.receive({ t: "records", records: [parent] });
    peerA.receive({ t: "done", mesh: peerA.meshId });
    await peerA.settled();
    const stored = (peerA.store.read()?.records ?? []).map(hashOf);
    expect(stored).toContain(hashOf(parent));
    expect(stored).toContain(hashOf(child));
  });

  test("what the peer lacks goes as records lines, in stored order, then done with the mesh id", async () => {
    const [a, b] = [peer("a"), peer("b")];
    const records: Signed[] = [...meshOf([a, b]).records];
    const founder = new Signer(a, records);
    for (let i = 0; i < 20; i++) records.push(founder.name(headsOfRecords(records), `n${i}`));
    const peerA = sessionAtB(records);
    peerA.receive({ t: "hello", v: 2, mesh: peerA.meshId, heads: [], n: {} });
    await peerA.settled();
    const sent = peerA.sent.filter((line) => line.t === "records" || line.t === "done");
    const sizes = sent.map((line) => new TextEncoder().encode(`${JSON.stringify(line)}\n`).byteLength);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_LINE_BYTES);
    expect(sent.at(-1)).toEqual({ t: "done", mesh: peerA.meshId });
    expect(sent.flatMap((line) => (line.t === "records" ? line.records.map(hashOf) : []))).toEqual(records.map(hashOf));
  });
});
