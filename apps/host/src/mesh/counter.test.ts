import { describe, expect, test } from "bun:test";
import { appendOwn, CounterBehindError, mergeBatch } from "./merge.ts";
import { FakeClock, seededRandom } from "./testing/fake-clock.ts";
import { FakeSigner, fakeRules, MemoryFile, MESH_ID, meshOf, member } from "./testing/fake-mesh.ts";
import { MeshNet } from "./testing/mesh-net.ts";
import { scripted } from "./testing/scripted.ts";

const [a, b] = [member("a"), member("b")];
const acksBy = (file: MemoryFile, who: string): number =>
  file.read().records.filter((record) => {
    const header = fakeRules.headerOf(record);
    return header.type === "ack" && header.by === who;
  }).length;

describe("a counter behind what peers hold of this host's records signs nothing (section 10.1)", () => {
  test("a merge with a peer's hello.n above this host's own records writes no ack", () => {
    const file = new MemoryFile(meshOf([a, b]));
    const deps = { file, rules: fakeRules, signer: new FakeSigner(b, 0), counterFloor: 4 };
    const admit = new FakeSigner(a, 2).admit(member("c"), fakeRules.headsOf(file.read().records));
    const result = mergeBatch(deps, [admit]);
    expect(result.added).toEqual([admit]);
    expect(result.ack).toBeUndefined();
    expect(result.counterBehind).toBe(true);
    expect(acksBy(file, b.signPub)).toBe(0);
  });

  test("an own record (a revoke, a leave) is refused while behind", () => {
    const file = new MemoryFile(meshOf([a, b]));
    const deps = { file, rules: fakeRules, signer: new FakeSigner(b, 0), counterFloor: 4 };
    const revoke = (prev: readonly string[]) =>
      ({ type: "revoke", prev, signPubs: [a.signPub], reason: "revoke" }) as const;
    expect(() => appendOwn(deps, revoke)).toThrow(CounterBehindError);
    expect(file.read().records.length).toBe(2);
  });

  test("a sync session's hello.n sets the floor below which the host signs nothing", async () => {
    const clock = new FakeClock();
    const net = new MeshNet(clock, seededRandom(29));
    const base = meshOf([a, b]);
    const host = net.add(b, base);
    const peer = scripted();
    host.gossip.attach(a.signPub, a.signPub, peer.channel);
    peer.receive({ t: "hello", v: 2, mesh: MESH_ID, heads: fakeRules.headsOf(base), n: { [b.signPub]: 6 } });
    const admit = new FakeSigner(a, 2).admit(member("c"), fakeRules.headsOf(base));
    peer.receive({ t: "records", records: [admit] });
    peer.receive({ t: "done" });
    await clock.advance(1_000);
    expect(acksBy(host.file, b.signPub)).toBe(0);
    expect(() =>
      host.gossip.append((prev) => ({ type: "revoke", prev, signPubs: [b.signPub], reason: "leave" })),
    ).toThrow(CounterBehindError);
  });
});
