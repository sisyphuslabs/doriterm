import { describe, expect, test } from "bun:test";
import { hashOf, parseRecord, type Signed } from "@doriface/mesh";
import { FakeClock, seededRandom, settle } from "./testing/fake-clock.ts";
import { meshOf, peer } from "./testing/mesh-peers.ts";
import { MeshNet } from "./testing/mesh-net.ts";

const acksBy = (records: readonly Signed[], who: string): readonly Signed[] =>
  records.filter((record) => {
    const body = parseRecord(record);
    return body?.type === "ack" && body.by === who;
  });

describe("the joiner's ack of its own admission (section 5.5)", () => {
  test("a host that joined from a welcome acks its admit once, and the inviter gets the ack", async () => {
    const [a, b, c] = [peer("a"), peer("b"), peer("c")];
    const clock = new FakeClock();
    const net = new MeshNet(clock, seededRandom(41));
    const { records } = meshOf([a, b]);
    const hostA = net.add(a, records);
    net.add(b, records);
    const admit = hostA.admit(c);
    const hostC = net.add(c, hostA.records());
    expect(hostC.gossip.ackAdmission()).toBe(true);
    expect(hostC.gossip.ackAdmission()).toBe(false);
    await settle();
    const own = acksBy(hostC.records(), c.signPub);
    expect(own).toHaveLength(1);
    expect(parseRecord(own[0] ?? { body: "", sig: "" })?.prev).toContain(hashOf(admit));
    await clock.advance(5_000);
    expect(acksBy(hostA.records(), c.signPub)).toHaveLength(1);
  });
});
