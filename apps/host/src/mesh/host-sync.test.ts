import { describe, expect, test } from "bun:test";
import { HostSync } from "./host-sync.ts";
import { FakeClock, seededRandom } from "./testing/fake-clock.ts";
import { meshOf, peer, storeOf } from "./testing/mesh-peers.ts";

/** b's running mesh with a, where every dial is recorded and fails: what matters is whom the host chose to dial. */
function hostSyncAtB() {
  const [a, b] = [peer("a"), peer("b")];
  const clock = new FakeClock();
  const dialed: string[] = [];
  const sync = new HostSync({
    identity: b.machine.identity,
    mesh: storeOf(b, meshOf([a, b]).records),
    relay: {
      url: "ws://relay.invalid",
      createSocket: (url) => {
        dialed.push(url);
        throw new Error("no relay here");
      },
    },
    log: () => undefined,
    clock,
    random: seededRandom(31),
  });
  sync.changed();
  return { a, clock, dialed, sync };
}

describe("this host's own uplink returning (section 5.1)", () => {
  test("after a drop of more than 2 minutes the host sweeps with a member; after a short one it does not", async () => {
    const { a, clock, dialed, sync } = hostSyncAtB();
    sync.uplinkDropped();
    await clock.advance(60_000);
    const beforeShort = dialed.length;
    sync.uplinkAnswered();
    await clock.advance(1);
    expect(dialed.length).toBe(beforeShort);
    sync.uplinkDropped();
    await clock.advance(121_000);
    const beforeAnswer = dialed.length;
    sync.uplinkAnswered();
    await clock.advance(1);
    expect(dialed.slice(beforeAnswer).some((url) => url.includes(a.hostId))).toBe(true);
    sync.stop();
  });
});
