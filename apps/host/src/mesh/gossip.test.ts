import { describe, expect, test } from "bun:test";
import { hashOf, parseRecord, type Signed } from "@doriface/mesh";
import { FakeClock, seededRandom } from "./testing/fake-clock.ts";
import { meshOf, peer } from "./testing/mesh-peers.ts";
import { MeshNet, type NetHost } from "./testing/mesh-net.ts";

function mesh(): { clock: FakeClock; net: MeshNet } {
  const clock = new FakeClock();
  const net = new MeshNet(clock, seededRandom(7));
  const members = ["a", "b", "c", "d"].map(peer);
  const { records } = meshOf(members);
  for (const entry of members) net.add(entry, records);
  return { clock, net };
}

const isAck = (record: Signed): boolean => parseRecord(record)?.type === "ack";
const holds = (host: NetHost, record: Signed): boolean => host.records().some((r) => hashOf(r) === hashOf(record));

describe("push (S-2)", () => {
  test("a revoke goes to the others first and to the revoked member last, after an ack came back", async () => {
    const { clock, net } = mesh();
    const a = net.host("a");
    const [revoke] = a.gossip.append({ type: "revoke", signPubs: [peer("d").signPub], reason: "revoke" }).added;
    if (revoke === undefined) throw new Error("no revoke written");
    await clock.until(() => holds(net.host("d"), revoke), 11_000);

    const toD = (index: number): boolean => net.lines[index]?.to === peer("d").signPub;
    const firstToD = net.lines.findIndex((entry, i) => toD(i) && entry.line.t === "records");
    const firstAck = net.lines.findIndex(
      (entry) =>
        entry.to === a.member.signPub &&
        entry.line.t === "records" &&
        entry.line.records.some((record) => isAck(record)),
    );
    expect(firstAck).toBeGreaterThanOrEqual(0);
    expect(firstToD).toBeGreaterThan(firstAck);
    expect(net.lines.some((entry) => entry.to === peer("b").signPub && entry.line.t === "records")).toBe(true);
  });

  test("acks reply on the pusher's session and the pusher forwards them: the others dial nobody", async () => {
    const { clock, net } = mesh();
    const a = net.host("a");
    a.gossip.append({ type: "revoke", signPubs: [peer("d").signPub], reason: "revoke" });
    await clock.advance(15_000);
    const ackBy = (name: string): boolean =>
      net
        .host("c")
        .records()
        .some((record) => isAck(record) && parseRecord(record)?.by === peer(name).signPub);
    expect(ackBy("b")).toBe(true);
    expect(net.host("b").dials).toEqual([]);
    expect(net.host("c").dials).toEqual([]);
    expect(a.dials.toSorted()).toEqual(["b", "c", "d"]);
  });
});

describe("format answers follow the roster (#1005)", () => {
  test("a member revoked from the mesh takes its answer with it; the others keep theirs", () => {
    const { net } = mesh();
    const a = net.host("a");
    a.gossip.heard(peer("b").signPub, [], {}, [2, 3]);
    a.gossip.heard(peer("d").signPub, [], {}, [2, 3]);
    a.gossip.append({ type: "revoke", signPubs: [peer("d").signPub], reason: "revoke" });
    expect(a.gossip.formatAnswers().map((answer) => answer.hostId)).toEqual([peer("b").signPub]);
  });
});
