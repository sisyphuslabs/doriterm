import { describe, expect, test } from "bun:test";
import { FakeClock, seededRandom } from "./testing/fake-clock.ts";
import { fakeRules, hashOfRecord, meshOf, member } from "./testing/fake-mesh.ts";
import { MeshNet } from "./testing/mesh-net.ts";

function mesh(): { clock: FakeClock; net: MeshNet } {
  const clock = new FakeClock();
  const net = new MeshNet(clock, seededRandom(7));
  const members = ["a", "b", "c", "d"].map(member);
  const base = meshOf(members);
  for (const entry of members) net.add(entry, base);
  return { clock, net };
}

const recordsLines = (net: MeshNet, to: string) =>
  net.lines.filter((line) => line.to === net.host(to).member.signPub && line.message.t === "records");

describe("push (S-2)", () => {
  test("a revoke goes to the others first and to the revoked member last, after an ack came back", async () => {
    const { clock, net } = mesh();
    const a = net.host("a");
    const result = a.gossip.append((prev) => ({
      type: "revoke",
      prev,
      signPubs: [member("d").signPub],
      reason: "revoke",
    }));
    const revoke = result.added[0];
    if (revoke === undefined) throw new Error("no revoke written");
    await clock.until(
      () =>
        net
          .host("d")
          .file.read()
          .records.some((r) => hashOfRecord(r) === hashOfRecord(revoke)),
      11_000,
    );

    const firstToD = net.lines.findIndex((line) => line.to === member("d").signPub && line.message.t === "records");
    const firstAck = net.lines.findIndex(
      (line) =>
        line.to === a.member.signPub &&
        line.message.t === "records" &&
        line.message.records.some((record) => fakeRules.headerOf(record).type === "ack"),
    );
    expect(firstAck).toBeGreaterThanOrEqual(0);
    expect(firstToD).toBeGreaterThan(firstAck);
    expect(recordsLines(net, "b").length).toBeGreaterThan(0);
  });

  test("acks reply on the pusher's session and the pusher forwards them: the others dial nobody", async () => {
    const { clock, net } = mesh();
    const a = net.host("a");
    a.gossip.append((prev) => ({ type: "revoke", prev, signPubs: [member("d").signPub], reason: "revoke" }));
    await clock.advance(15_000);
    const ackBy = (name: string) =>
      net
        .host("c")
        .file.read()
        .records.some((record) => {
          const header = fakeRules.headerOf(record);
          return header.type === "ack" && header.by === member(name).signPub;
        });
    expect(ackBy("b")).toBe(true);
    expect(net.host("b").dials).toEqual([]);
    expect(net.host("c").dials).toEqual([]);
    expect(a.dials.toSorted()).toEqual(["b", "c", "d"]);
  });
});
