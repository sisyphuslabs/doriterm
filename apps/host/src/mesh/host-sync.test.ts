import { describe, expect, test } from "bun:test";
import { type SecureLink, SessionKind } from "@doriface/crypto";
import { memoryLinkPair } from "@doriface/crypto/testing";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayProofs } from "@doriface/relay-client";
import { viewOf } from "@doriface/mesh";
import { MeshStore } from "../state/mesh.ts";
import { CLIENT_ADMISSION_FORMAT } from "./format-readiness.ts";
import { HostSync } from "./host-sync.ts";
import { FakeClock, seededRandom } from "./testing/fake-clock.ts";
import { meshOf, type Peer, peer, storeOf } from "./testing/mesh-peers.ts";

/** A host's own sync over `store`, where every dial is recorded and fails: what matters is what it reads of the mesh. */
function hostSyncOver(owner: Peer, store: MeshStore, proofs?: RelayProofs) {
  const clock = new FakeClock();
  const dialed: string[] = [];
  const logs: string[] = [];
  const sync = new HostSync({
    identity: owner.machine.identity,
    mesh: store,
    relay: {
      url: "ws://relay.invalid",
      createSocket: (url) => {
        dialed.push(url);
        throw new Error("no relay here");
      },
      ...(proofs === undefined ? {} : { proofs }),
    },
    hc: { hc: "hc-not-installed" },
    stateDir: mkdtempSync(join(tmpdir(), "dh-host-sync-")),
    program: "/opt/doriface-host",
    openFrom: () => false,
    closeRevoked: () => undefined,
    log: (line) => void logs.push(line),
    clock,
    random: seededRandom(31),
  });
  return { clock, dialed, sync, logs };
}

/** b's running mesh with a, and the host that syncs over it. */
function hostSyncAtB(proofs?: RelayProofs) {
  const [a, b] = [peer("a"), peer("b")];
  return { a, ...hostSyncOver(b, storeOf(b, meshOf([a, b]).records), proofs) };
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
  test("missing local state and an unknown member have distinct close sources", async () => {
    const empty = new MeshStore(mkdtempSync(join(tmpdir(), "dh-no-mesh-")), { log: () => undefined, durable: false });
    const missing = hostSyncOver(peer("b"), empty);
    const known = hostSyncAtB();
    try {
      missing.sync.adopt(keptSession(peer("a").machine.identity.noise.publicKey, false));
      known.sync.adopt(keptSession(peer("outsider").machine.identity.noise.publicKey, false));
      expect(missing.logs).toContain("mesh: close code=4401 source=host-sync-state: this host is in no mesh");
      expect(known.logs).toContain("mesh: close code=4401 source=host-sync-member: not a member of this mesh");
    } finally {
      await Promise.all([missing.sync.stop(), known.sync.stop()]);
    }
  });

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
    await sync.stop();
  });
});

describe("a host that keeps no relay uplink (M-D3)", () => {
  test("dials no member at all: nothing reaches a relay it was not given", async () => {
    const [a, b] = [peer("a"), peer("b")];
    const clock = new FakeClock();
    const dialed: string[] = [];
    const logs: string[] = [];
    const sync = new HostSync({
      identity: b.machine.identity,
      mesh: storeOf(b, meshOf([a, b]).records),
      relay: {
        url: undefined,
        createSocket: (url) => {
          dialed.push(url);
          throw new Error("no relay here");
        },
      },
      hc: { hc: "hc-not-installed" },
      stateDir: mkdtempSync(join(tmpdir(), "dh-host-sync-")),
      program: "/opt/doriface-host",
      openFrom: () => false,
      closeRevoked: () => undefined,
      log: (line) => void logs.push(line),
      clock,
      random: seededRandom(37),
    });
    sync.changed();
    sync.uplinkDropped();
    await clock.advance(121_000);
    sync.uplinkAnswered();
    await clock.advance(1);
    expect(dialed).toEqual([]);
    expect(logs.some((line) => line.includes("no relay"))).toBe(true);
    sync.stop();
  });

  test("says so once and gates no member, so nothing is retried on a probe clock (L-E5)", async () => {
    const [a, b] = [peer("a"), peer("b")];
    const clock = new FakeClock();
    const logs: string[] = [];
    const sync = new HostSync({
      identity: b.machine.identity,
      mesh: storeOf(b, meshOf([a, b]).records),
      relay: { url: undefined },
      hc: { hc: "hc-not-installed" },
      stateDir: mkdtempSync(join(tmpdir(), "dh-host-sync-")),
      program: "/opt/doriface-host",
      openFrom: () => false,
      closeRevoked: () => undefined,
      log: (line) => void logs.push(line),
      clock,
      random: seededRandom(39),
    });
    sync.changed();
    await clock.advance(10 * 60_000);
    expect(logs.filter((line) => line.includes("no relay uplink"))).toHaveLength(1);
    await sync.stop();
  });
});

describe("a new relay pass (contract v1.6)", () => {
  test("makes a member whose dial was refused for its pass due again", async () => {
    const passListeners: ((origin: string) => void)[] = [];
    const proofs: RelayProofs = {
      presents: () => false,
      proof: () => undefined,
      received: () => undefined,
      refused: () => undefined,
      accepted: () => undefined,
      wantsPass: () => false,
      onWant: () => () => undefined,
      onPass: (listener) => {
        passListeners.push(listener);
        return () => undefined;
      },
    };
    const { a, clock, dialed, sync } = hostSyncAtB(proofs);
    sync.changed();
    await clock.advance(1);
    // The start sweep's dial failed (no relay here) and gated a as offline; a session from it clears that first.
    const policy = sync.runtime?.policy;
    expect(policy).toBeDefined();
    policy?.report(a.signPub, "connected");
    policy?.report(a.signPub, 4412);
    const before = dialed.length;
    for (const listener of passListeners) listener("ws://relay.invalid");
    await clock.advance(2_001);
    expect(dialed.slice(before).some((url) => url.includes(a.hostId))).toBe(true);
    await sync.stop();
  });
});

describe("the format a client's admission needs, asked before sync runs (#1415)", () => {
  test("a host with no mesh is ready: the join founds a roster of one, and nobody is in it to hold it back", () => {
    const empty = new MeshStore(mkdtempSync(join(tmpdir(), "dh-no-mesh-")), { log: () => undefined, durable: false });
    const { sync } = hostSyncOver(peer("b"), empty);
    expect(sync.formatReady()).toBe(true);
    sync.stop();
  });

  test("a one-machine mesh is ready, and a machine that has not answered still blocks it", () => {
    const b = peer("b");
    const alone = hostSyncOver(b, storeOf(b, meshOf([b]).records));
    expect(alone.sync.formatReady()).toBe(true);
    const both = hostSyncOver(b, storeOf(b, meshOf([peer("a"), peer("b")]).records));
    expect(both.sync.formatReady()).toBe(false);
    alone.sync.stop();
    both.sync.stop();
  });

  test("with sync running, it reads the members' answers: ready once every other machine reads the format (#1436)", async () => {
    const [a, b, c] = [peer("a"), peer("b"), peer("c")];
    const { clock, sync } = hostSyncOver(b, storeOf(b, meshOf([a, b, c]).records));
    sync.changed();
    await clock.advance(1);
    const gossip = sync.gossip;
    expect(gossip).toBeDefined();
    gossip?.heard(a.signPub, [], {}, [CLIENT_ADMISSION_FORMAT]);
    gossip?.heard(c.signPub, [], {}, [CLIENT_ADMISSION_FORMAT - 1]);
    expect(sync.formatReady()).toBe(false);
    gossip?.heard(c.signPub, [], {}, [CLIENT_ADMISSION_FORMAT - 1, CLIENT_ADMISSION_FORMAT]);
    expect(sync.formatReady()).toBe(true);
    sync.stop();
  });

  test("an admission reads the roster from the records it is written over, not gossip's last view (#1436)", async () => {
    const [a, b, c, d] = [peer("a"), peer("b"), peer("c"), peer("d")];
    const { clock, sync } = hostSyncOver(b, storeOf(b, meshOf([a, b, c]).records));
    sync.changed();
    await clock.advance(1);
    const gossip = sync.gossip;
    if (gossip === undefined) throw new Error("sync did not start");
    gossip.heard(a.signPub, [], {}, [CLIENT_ADMISSION_FORMAT]);
    gossip.heard(c.signPub, [], {}, [CLIENT_ADMISSION_FORMAT]);
    expect(sync.formatReady()).toBe(true);
    // A machine admitted on this host a moment ago: on disk, but not yet in gossip's view, and it has not answered.
    const onDisk = meshOf([a, b, c, d]).records;
    expect(sync.formatReady(onDisk)).toBe(false);
    sync.stop();
  });

  test("an admission's roster comes from the view the transaction holds, not a second evaluation of its records (#2263)", async () => {
    const [a, b, c, d] = [peer("a"), peer("b"), peer("c"), peer("d")];
    const { clock, sync } = hostSyncOver(b, storeOf(b, meshOf([a, b, c]).records));
    sync.changed();
    await clock.advance(1);
    const gossip = sync.gossip;
    if (gossip === undefined) throw new Error("sync did not start");
    gossip.heard(a.signPub, [], {}, [CLIENT_ADMISSION_FORMAT]);
    gossip.heard(c.signPub, [], {}, [CLIENT_ADMISSION_FORMAT]);
    const records = meshOf([a, b, c]).records;
    // The records alone read ready; the view handed in also holds d, which has not answered, so the view decides.
    expect(sync.formatReady(records)).toBe(true);
    expect(sync.formatReady(records, viewOf(meshOf([a, b, c, d]).records))).toBe(false);
    sync.stop();
  });
});
