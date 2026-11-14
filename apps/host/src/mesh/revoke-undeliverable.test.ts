import { describe, expect, test } from "bun:test";
import { CloseCode } from "@doriface/crypto";
import { FakeClock, seededRandom } from "./testing/fake-clock.ts";
import { meshOf, peer } from "./testing/mesh-peers.ts";
import { MeshNet } from "./testing/mesh-net.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("a revoke owed to a revoked member that answers but refuses every handshake (section 5.3)", () => {
  test("the revoker dials it a handful of times a day, not on every probe", async () => {
    const [a, b, c] = [peer("a"), peer("b"), peer("c")];
    const clock = new FakeClock();
    const net = new MeshNet(clock, seededRandom(91));
    const { records } = meshOf([a, b, c]);
    const atA = net.add(a, records);
    net.add(b, records);
    net.add(c, records);
    // It answers a dial but refuses the handshake, and never dials out: it cannot take the revoke any other way.
    net.refuse("c", CloseCode.CryptoFailure);
    net.offline("c");
    atA.gossip.append({ type: "revoke", signPubs: [c.signPub], reason: "revoke" });
    await clock.until(() => !atA.names().includes("c"), 5_000, 10);
    const before = atA.dials.filter((name) => name === "c").length;
    await clock.advance(DAY_MS);
    const dials = atA.dials.filter((name) => name === "c").length - before;
    expect(dials).toBeGreaterThan(0);
    expect(dials).toBeLessThanOrEqual(6);
  });
});
