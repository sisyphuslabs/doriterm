import { describe, expect, test } from "bun:test";
import { FakeClock, seededRandom } from "./testing/fake-clock.ts";
import { meshOf, peer } from "./testing/mesh-peers.ts";
import { MeshNet, setOf } from "./testing/mesh-net.ts";

const SEED = 20261103;
/** Four real mesh.json stores, each write evaluating the view: real work, bounded well above its measured 1-10 s. */
const REAL_STORES_MS = 60_000;

function fourHosts(): { clock: FakeClock; net: MeshNet } {
  const clock = new FakeClock();
  const net = new MeshNet(clock, seededRandom(SEED));
  const members = ["a", "b", "c", "d"].map(peer);
  const { records } = meshOf(members);
  for (const entry of members) net.add(entry, records);
  return { clock, net };
}

describe("machine sync converges by itself (goal 2)", () => {
  test(
    "after a partition heals, every host holds every record and computes the same view",
    async () => {
      const { clock, net } = fourHosts();
      net.partition(["a", "b"], ["c", "d"]);
      net.host("a").admit(peer("e"));
      net.host("c").admit(peer("f"));
      await clock.advance(5_000);
      expect(net.host("b").names()).toEqual(["a", "b", "c", "d", "e"]);
      expect(net.host("d").names()).toEqual(["a", "b", "c", "d", "f"]);
      expect(net.converged()).toBe(false);

      net.heal();
      const took = await clock.until(() => net.converged(), 6 * 60_000);
      console.log(`partition: converged ${took} ms (virtual) after the heal, no manual step`);
      for (const host of net.hosts.values()) expect(host.names()).toEqual(["a", "b", "c", "d", "e", "f"]);
    },
    REAL_STORES_MS,
  );

  test(
    "a host offline for hours catches up within 65 s of its uplink answering, and delivers what it wrote",
    async () => {
      const { clock, net } = fourHosts();
      const d = net.host("d");
      net.offline("d");
      net.host("a").admit(peer("e"));
      d.admit(peer("g"));
      await clock.advance(6 * 60 * 60_000);
      expect(d.names()).toEqual(["a", "b", "c", "d", "g"]);

      net.online("d");
      d.gossip.uplinkReturned(6 * 60 * 60_000);
      // The return sweep runs at once; every other dial back waits the settle (at least 10 s).
      const swept = await clock.until(() => d.names().includes("e"), 9_999);
      const took = await clock.until(() => net.converged(), 65_000);
      console.log(`return: what d missed arrived ${swept} ms after the uplink answered`);
      console.log(`return: converged ${took} ms (virtual) after the uplink answered`);
      for (const host of net.hosts.values()) expect(host.names()).toEqual(["a", "b", "c", "d", "e", "g"]);
    },
    REAL_STORES_MS,
  );

  test(
    "an admission and a revocation reach every online member's view within the 48 s bound",
    async () => {
      const { clock, net } = fourHosts();
      net.host("b").admit(peer("e"));
      const hosts = [...net.hosts.values()];
      const added = await clock.until(() => hosts.every((host) => host.names().includes("e")), 48_000);
      const a = net.host("a");
      a.gossip.append({ type: "revoke", signPubs: [peer("c").signPub], reason: "revoke" });
      const removed = await clock.until(() => hosts.every((host) => !host.names().includes("c")), 48_000);
      console.log(`propagation: admit everywhere in ${added} ms, revoke everywhere in ${removed} ms (virtual)`);
      expect(setOf(net.host("c"))).toEqual(setOf(a));
    },
    REAL_STORES_MS,
  );
});
