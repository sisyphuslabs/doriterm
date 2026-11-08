import { CloseCode, PAIRING_TTL_MS, rawStaticKey, secureLink, type SecureLink, SessionKind } from "@doriface/crypto";
import { memoryLinkPair, type MemoryEnd } from "@doriface/crypto/testing";
import { meshInviteOf } from "@doriface/mesh/join";
import { OPEN_POLICY } from "@doriface/policy";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveSessions } from "../e2ee/sessions.ts";
import { acceptE2ee } from "../e2ee/accept.ts";
import { PairingSlots } from "../pairing-slots.ts";
import { DeviceStore } from "../state/devices.ts";
import { MeshStore } from "../state/mesh.ts";
import { PairingStore } from "../state/pairing.ts";
import { removeSides, side, type Side } from "../testing/join-harness.ts";
import { machine } from "../testing/mesh-history.ts";
import { HostMesh } from "./host-mesh.ts";
import { runJoiner } from "./join.ts";
import { JOINER_EXPECTS, MeshLines } from "./lines.ts";

const dirs: string[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  removeSides();
  for (const stop of stops.splice(0)) stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const log = (): void => {};
const invite = meshInviteOf({ kind: "link", mesh: true });
const comparison = { handshakeHash: new Uint8Array(32), yes: true, confirm: undefined };

function hostMesh(sync?: (session: SecureLink) => void, Sessions = LiveSessions) {
  const dir = mkdtempSync(join(tmpdir(), "dh-host-mesh-"));
  dirs.push(dir);
  const m = machine("alpha");
  const mesh = new MeshStore(dir, { log });
  const slots = new PairingSlots(new PairingStore(dir, log), m.identity.noise.publicKey, undefined, log);
  stops.push(() => slots.stop());
  const sessions = new Sessions(new DeviceStore(dir), log, mesh);
  const create = (): HostMesh =>
    new HostMesh({
      stateDir: dir,
      identity: m.identity,
      mesh,
      slots,
      sessions,
      policy: OPEN_POLICY,
      hc: { hc: "hc" },
      relay: { url: undefined },
      log,
      sync,
      floor: () => undefined,
    });
  return { dir, m, mesh, sessions, create };
}

const pairLink = (end: MemoryEnd, remoteStatic: Uint8Array, kind: SessionKind = SessionKind.PairLink): SecureLink =>
  Object.assign(end, {
    kind,
    remoteStatic,
    handshakeHash: new Uint8Array(32),
    peerName: "beta",
    lanUrls: [],
    stream: "mesh" as const,
  });

async function joining(fixture: ReturnType<typeof hostMesh>, host: HostMesh, joiner: Side) {
  const offer = await host.pair(true);
  const [inviterEnd, joinerEnd] = memoryLinkPair();
  const [served, joined] = await Promise.all([
    acceptE2ee(
      inviterEnd,
      {
        identity: fixture.m.identity,
        mesh: fixture.mesh,
        pairing: new PairingStore(fixture.dir),
        devices: new DeviceStore(fixture.dir),
        policy: OPEN_POLICY,
        live: fixture.sessions,
        lanUrls: [],
        log,
      },
      { kind: "relay" },
    ),
    secureLink(joinerEnd, {
      role: "initiator",
      hostId: fixture.m.identity.hostId,
      staticKey: rawStaticKey(joiner.m.identity.noise),
      remoteStatic: fixture.m.identity.noise.publicKey,
      stream: "mesh",
      pairing: { mode: "link", linkSecret: offer.linkSecret, name: joiner.m.name },
    }),
  ]);
  if (served === undefined) throw new Error("the join handshake was refused");
  host.serve(served);
  return { inviterEnd, joined, served };
}

describe("the running host's mesh offers", () => {
  test("opening a mesh offer expires the pending joins of the offer it replaces", async () => {
    const host = hostMesh().create();
    const asked = host.pending.ask({
      nonce: "old",
      name: "beta",
      noisePub: "noise-beta",
      hostId: "h",
      fingerprint: "f",
      expiresAt: Date.now() + 60_000,
      kind: "machine",
      code: "123 456",
      joinerConfirmed: false,
    });
    await host.pair(false);
    expect(await asked).toBe("expired");
    expect(host.pending.list()).toEqual([]);
  });

  test("an offer left in pairing.json before the host started still bounds the card step to its expiry", async () => {
    const { dir, m, mesh, create } = hostMesh();
    mesh.found(m.identity, { name: "alpha", hcId: "core" });
    new PairingStore(dir).offer(Date.now() - PAIRING_TTL_MS + 100, true);
    const [inviterEnd, joinerEnd] = memoryLinkPair();
    create().serve(pairLink(inviterEnd, new Uint8Array(32)));
    const joiner = new MeshLines(joinerEnd, JOINER_EXPECTS);
    expect((await joiner.next()).t).toBe("offer");
    const ended = await joiner.next().then(
      () => "read",
      (error: unknown) => String(error),
    );
    expect(ended).toContain("the offer expired before the card arrived");
    expect(inviterEnd.closeCode).toBe(CloseCode.UnknownDevice);
  });

  test("the session a served join ran on is registered, so a revoke closes it", async () => {
    const fixture = hostMesh();
    const { dir, m, mesh, sessions, create } = fixture;
    mesh.found(m.identity, { name: "alpha", hcId: "core" });
    const host = create();
    const b = side("beta");
    const { inviterEnd, joined } = await joining(fixture, host, b);
    const dialed = { hostId: m.identity.hostId, noisePub: m.identity.noise.publicKey };
    const ctx = {
      ...comparison,
      invite,
      identity: b.m.identity,
      mesh: b.mesh,
      own: { name: "beta", hcId: "core-b" },
      dialed,
      log,
    };
    await runJoiner(new MeshLines(joined, JOINER_EXPECTS), { ...ctx, deadline: Date.now() + 60_000 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(inviterEnd.closeCode).toBeUndefined();
    rmSync(join(dir, "mesh.json"));
    sessions.closeRevoked();
    expect(inviterEnd.closeCode).toBe(CloseCode.UnknownDevice);
  });

  test("an authorized mesh sync session is handed to the sync hook and stays open", async () => {
    const synced: SecureLink[] = [];
    const host = hostMesh((session) => void synced.push(session)).create();
    const [end] = memoryLinkPair();
    const session = pairLink(end, new Uint8Array(32), SessionKind.Session);
    host.serve(session);
    expect(synced).toEqual([session]);
    expect(end.closeCode).toBeUndefined();
  });

  test("without a sync hook, an authorized mesh sync session stays open", () => {
    const [end] = memoryLinkPair();
    hostMesh()
      .create()
      .serve(pairLink(end, new Uint8Array(32), SessionKind.Session));
    expect(end.closeCode).toBeUndefined();
  });

  test("the session a served join ran on is handed to the sync hook once the join is over", async () => {
    const synced: SecureLink[] = [];
    const fixture = hostMesh((session) => void synced.push(session));
    const { m, mesh, create } = fixture;
    mesh.found(m.identity, { name: "alpha", hcId: "core" });
    const host = create();
    const b = side("beta");
    const { inviterEnd, joined, served } = await joining(fixture, host, b);
    const dialed = { hostId: m.identity.hostId, noisePub: m.identity.noise.publicKey };
    const ctx = {
      ...comparison,
      invite,
      identity: b.m.identity,
      mesh: b.mesh,
      own: { name: "beta", hcId: "core-b" },
      dialed,
      log,
    };
    await runJoiner(new MeshLines(joined, JOINER_EXPECTS), { ...ctx, deadline: Date.now() + 60_000 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(synced).toEqual([served]);
    expect(inviterEnd.closeCode).toBeUndefined();
  });

  test("a session that closes as it is registered is not handed to the sync hook", async () => {
    // Production returns false only when a revoke lands between the admit and the hand-off; no test can schedule
    // that, so this fake stands in for it. LiveSessions.add's own result is pinned in e2ee/sessions.test.ts.
    class ClosingSessions extends LiveSessions {
      override add(session: SecureLink): boolean {
        session.close(CloseCode.UnknownDevice, "device revoked");
        return false;
      }
    }
    const synced: SecureLink[] = [];
    const fixture = hostMesh((session) => void synced.push(session), ClosingSessions);
    const { m, mesh, create } = fixture;
    mesh.found(m.identity, { name: "alpha", hcId: "core" });
    const host = create();
    const b = side("beta");
    const { inviterEnd, joined } = await joining(fixture, host, b);
    const dialed = { hostId: m.identity.hostId, noisePub: m.identity.noise.publicKey };
    const ctx = {
      ...comparison,
      invite,
      identity: b.m.identity,
      mesh: b.mesh,
      own: { name: "beta", hcId: "core-b" },
      dialed,
      log,
    };
    await runJoiner(new MeshLines(joined, JOINER_EXPECTS), { ...ctx, deadline: Date.now() + 60_000 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(inviterEnd.closeCode).toBe(CloseCode.UnknownDevice);
    expect(synced).toEqual([]);
  });

  test("opening a device offer expires the pending joins of the mesh offer it replaces", async () => {
    const host = hostMesh().create();
    const asked = host.pending.ask({
      nonce: "old",
      name: "beta",
      noisePub: "noise-beta",
      hostId: "h",
      fingerprint: "f",
      expiresAt: Date.now() + 60_000,
      kind: "machine",
      code: "123 456",
      joinerConfirmed: false,
    });
    await host.pairDevice();
    expect(await asked).toBe("expired");
  });
});
