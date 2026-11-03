import { describe, expect, spyOn, test } from "bun:test";
import { hashOf } from "@doriface/mesh";
import { FakeClock, seededRandom } from "./testing/fake-clock.ts";
import { headsOfRecords, meshOf, peer, Signer } from "./testing/mesh-peers.ts";
import { MeshNet } from "./testing/mesh-net.ts";

describe("the records every hello and want read (abuse, section 5.2)", () => {
  test("are parsed once per written mesh.json, not once per line", () => {
    const [a, b] = [peer("a"), peer("b")];
    const { records } = meshOf([a, b]);
    const host = new MeshNet(new FakeClock(), seededRandom(5)).add(b, records);
    const reads = spyOn(host.store, "read");
    host.gossip.records();
    const parsed = reads.mock.calls.length;
    for (let line = 0; line < 50; line++) host.gossip.records();
    expect(reads.mock.calls.length).toBe(parsed);
    const admit = new Signer(a, records).admit(peer("c"), headsOfRecords(records));
    host.store.transact((tx) => void tx.merge([admit]));
    expect(host.gossip.records().map(hashOf)).toContain(hashOf(admit));
  });
});
