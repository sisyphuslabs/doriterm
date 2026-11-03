import { describe, expect, test } from "bun:test";
import { hashOf, MAX_DANGLING } from "@doriface/mesh";
import { mergeBatch } from "./merge.ts";
import { meshOf, peer, Signer, storeOf } from "./testing/mesh-peers.ts";

const missing = (i: number): string => hashOf({ body: `{"missing":${i}}`, sig: "" });

describe("the dangling cap through a sync merge (section 3.3)", () => {
  test("the pool keeps the newest 256 held records", () => {
    const [a, b] = [peer("a"), peer("b")];
    const { records, meshId } = meshOf([a, b]);
    const store = storeOf(b, records);
    const founder = new Signer(a, records);
    const held = Array.from({ length: MAX_DANGLING + 44 }, (_, i) => founder.name([missing(i)], `h${i}`));
    const result = mergeBatch({ store, identity: b.machine.identity, meshId }, held);
    expect(result.added).toEqual([]);
    expect(store.read()?.dangling.map(hashOf)).toEqual(held.slice(-MAX_DANGLING).map(hashOf));
  });
});
