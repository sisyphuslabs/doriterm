import { describe, expect, test } from "bun:test";
import { type SecureLink, SessionKind } from "@doriface/crypto";
import { memoryLinkPair } from "@doriface/crypto/testing";
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
  return { a, clock, dialed, sync };
}

/** The session a join ran on, as HostMesh hands it over: the inviter's side received the joiner's name. */
function keptSession(peerNoise: Uint8Array, inviterSide: boolean): SecureLink {
  const [end] = memoryLinkPair(true);
  const info = {
    kind: SessionKind.PairLink,
    remoteStatic: peerNoise,
    handshakeHash: new Uint8Array(32),
    peerName: inviterSide ? "b" : undefined,
    lanUrls: [],
    stream: "mesh" as const,
  };
  return Object.assign(end, info);
}

describe("a join's kept session (section 4.4, M-D1)", () => {
  test.each([
    ["the joiner's side", false],
    ["the inviter's side", true],
  ])("%s is attached before the host dials, so the start sweep and the pushes go over it", async (_side, inviter) => {
    const { a, clock, dialed, sync } = hostSyncAtB();
    sync.adopt(keptSession(a.machine.identity.noise.publicKey, inviter));
    await clock.advance(1);
    expect(dialed.filter((url) => url.includes(a.hostId))).toEqual([]);
    sync.stop();
  });
});

describe("this host's own uplink returning (section 5.1)", () => {
  test("after a drop of more than 2 minutes the host sweeps with a member; after a short one it does not", async () => {
    const { a, clock, dialed, sync } = hostSyncAtB();
    sync.changed();
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
