import { describe, expect, test } from "bun:test";
import { CloseCode, type SecureLink, SessionKind } from "@doriface/crypto";
import { memoryLinkPair } from "@doriface/crypto/testing";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveSessions } from "../e2ee/sessions.ts";
import { PairingSlots } from "../pairing-slots.ts";
import { DeviceStore } from "../state/devices.ts";
import { PairingStore } from "../state/pairing.ts";
import { joinerContext, side } from "../testing/join-harness.ts";
import { meshDeps } from "./host-deps.ts";
import { IDLE_MESH_HOOKS } from "./host-hooks.ts";
import { runJoiner } from "./join.ts";
import { JOINER_EXPECTS, MeshLines } from "./lines.ts";
import { settle } from "./testing/fake-clock.ts";
import { meshOf, peer, storeOf } from "./testing/mesh-peers.ts";

const log = (): void => undefined;
const NO_HC = { hc: { hc: "hc-not-installed" }, relay: { url: undefined }, program: "/opt/doriface-host" };

describe("the running host's presence in mesh status (section 8.2)", () => {
  test("an hc line from a member open on this host is its presence, and its close ends it", async () => {
    const [a, b] = [peer("a"), peer("b")];
    const mesh = storeOf(a, meshOf([a, b]).records);
    const dir = mkdtempSync(join(tmpdir(), "dh-host-deps-"));
    const slots = new PairingSlots(new PairingStore(dir, log), a.machine.identity.noise.publicKey, undefined, log);
    const sessions = new LiveSessions(new DeviceStore(dir), log, mesh);
    const deps = meshDeps({
      stateDir: dir,
      identity: a.machine.identity,
      mesh,
      slots,
      sessions,
      hc: { hc: "hc-not-installed" },
      relay: { url: undefined },
      program: "/opt/doriface-host",
      log,
    });
    try {
      const [near] = memoryLinkPair(true);
      const line: SecureLink = Object.assign(near, {
        kind: SessionKind.Session,
        remoteStatic: b.machine.identity.noise.publicKey,
        handshakeHash: new Uint8Array(32),
        peerName: undefined,
        lanUrls: [],
        stream: "hc" as const,
      });
      expect(sessions.add(line)).toBe(true);
      expect(deps.hooks.live().peers.get(b.signPub)?.presence).toBe(true);
      near.close(1000, "done");
      await settle();
      expect(deps.hooks.live().peers.get(b.signPub)?.presence).toBe(false);
    } finally {
      await deps.sync.stop();
      slots.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a join the running host approves (section 10.1, #154)", () => {
  test("is refused while the sync's hooks report a standing claim above this host's counter", async () => {
    const [a, b] = [peer("a"), peer("b")];
    const mesh = storeOf(a, meshOf([a, b]).records);
    const dir = mkdtempSync(join(tmpdir(), "dh-host-deps-"));
    const slots = new PairingSlots(new PairingStore(dir, log), a.machine.identity.noise.publicKey, undefined, log);
    const sessions = new LiveSessions(new DeviceStore(dir), log, mesh);
    const hooks = { ...IDLE_MESH_HOOKS, floor: () => ({ n: 9, peer: "b" }) };
    const deps = meshDeps({ stateDir: dir, identity: a.machine.identity, mesh, slots, sessions, hooks, log, ...NO_HC });
    try {
      await deps.hostMesh.pair(true);
      const joiner = side("gamma");
      const [inviterEnd, joinerEnd] = memoryLinkPair();
      deps.hostMesh.serve(
        Object.assign(inviterEnd, {
          kind: SessionKind.PairLink,
          remoteStatic: joiner.m.identity.noise.publicKey,
          handshakeHash: new Uint8Array(32),
          peerName: "gamma",
          lanUrls: [],
          stream: "mesh" as const,
        }),
      );
      const inviter = { m: a.machine, dir, mesh, logs: [] };
      const joined = runJoiner(new MeshLines(joinerEnd, JOINER_EXPECTS), joinerContext(joiner, inviter)).then(
        () => "joined",
        (error: unknown) => String(error),
      );
      expect(await joined).toContain("holds counter 9 of this host's key");
      expect(inviterEnd.closeCode).toBe(CloseCode.UnknownDevice);
      expect(mesh.read()?.records).toHaveLength(meshOf([a, b]).records.length);
    } finally {
      await deps.sync.stop();
      slots.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
