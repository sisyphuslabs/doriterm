import { describe, expect, test } from "bun:test";
import { type SecureLink, SessionKind } from "@doriface/crypto";
import { memoryLinkPair, type MemoryEnd } from "@doriface/crypto/testing";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REVOKED } from "../e2ee/accept.ts";
import { LiveSessions } from "../e2ee/sessions.ts";
import { DeviceStore } from "../state/devices.ts";
import { HostSync } from "./host-sync.ts";
import type { MeshLine } from "./lines.ts";
import { FakeClock, seededRandom } from "./testing/fake-clock.ts";
import { headsOfRecords, meshIdOfRecords, meshOf, type Peer, peer, Signer, storeOf } from "./testing/mesh-peers.ts";

/** An authenticated session from `from`, as the accept path hands it over; the far end speaks for that peer. */
function sessionFrom(from: Peer): { readonly secure: SecureLink; readonly near: MemoryEnd; readonly far: MemoryEnd } {
  const [near, far] = memoryLinkPair(true);
  const info = {
    kind: SessionKind.Session,
    remoteStatic: from.machine.identity.noise.publicKey,
    handshakeHash: new Uint8Array(32),
    peerName: undefined,
    lanUrls: [],
    stream: "mesh" as const,
  };
  return { secure: Object.assign(near, info), near, far };
}

const say = (end: MemoryEnd, line: MeshLine): void => end.send(new TextEncoder().encode(`${JSON.stringify(line)}\n`));

describe("a member that merges a revoke through sync (section 6.3)", () => {
  test("closes the revoked member's live sessions with 4401 and leaves every other member's open", async () => {
    const [a, b, c, d] = [peer("a"), peer("b"), peer("c"), peer("d")];
    const { records } = meshOf([a, b, c, d]);
    const mesh = storeOf(b, records);
    const stateDir = mkdtempSync(join(tmpdir(), "dh-host-sync-revoke-"));
    const sessions = new LiveSessions(new DeviceStore(stateDir), () => undefined, mesh);
    const clock = new FakeClock();
    const sync = new HostSync({
      identity: b.machine.identity,
      mesh,
      relay: {
        url: "ws://relay.invalid",
        createSocket: () => {
          throw new Error("no relay here");
        },
      },
      hc: { hc: "hc-not-installed" },
      stateDir,
      program: "/opt/doriface-host",
      closeRevoked: () => sessions.closeRevoked(),
      log: () => undefined,
      clock,
      random: seededRandom(41),
    });
    const [fromC, fromD, fromA] = [sessionFrom(c), sessionFrom(d), sessionFrom(a)];
    expect([sessions.add(fromC.secure), sessions.add(fromD.secure)]).toEqual([true, true]);
    sync.adopt(fromA.secure);
    const meshId = meshIdOfRecords(records);
    const revoke = new Signer(a, records).revoke(headsOfRecords(records), c);
    say(fromA.far, { t: "hello", v: 2, mesh: meshId, heads: headsOfRecords(records), n: {} });
    say(fromA.far, { t: "records", records: [revoke] });
    say(fromA.far, { t: "done", mesh: meshId });
    await clock.advance(1);
    expect([fromC.near.closeCode, fromD.near.closeCode]).toEqual([REVOKED.code, undefined]);
    await sync.stop();
  });
});
