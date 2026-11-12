import { afterEach, describe, expect, test } from "bun:test";
import { PAIRING_TTL_MS } from "@doriface/crypto";
import { OPEN_POLICY } from "@doriface/policy";
import { LiveSessions } from "../e2ee/sessions.ts";
import { PairingSlots } from "../pairing-slots.ts";
import { DeviceStore } from "../state/devices.ts";
import { PairingStore } from "../state/pairing.ts";
import { failure, inviteDeps, joinerContext, removeSides, runJoin, side } from "../testing/join-harness.ts";
import { meshDeps } from "./host-deps.ts";
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  removeSides();
});
const log = () => {};

describe("the running host's pending joins in mesh status (section 4.3)", () => {
  test("a first pending join stays visible to approval without authorizing or persisting its mesh", async () => {
    const a = side("alpha");
    const b = side("beta");
    const { dir, m, mesh } = a;
    const slots = new PairingSlots(new PairingStore(dir, log), m.identity.noise.publicKey, undefined, log);
    const deps = meshDeps({
      stateDir: dir,
      identity: m.identity,
      mesh,
      slots,
      sessions: new LiveSessions(new DeviceStore(dir), log, mesh),
      policy: OPEN_POLICY,
      hc: { hc: "hc" },
      relay: { url: undefined },
      program: "/opt/doriface-host",
      log,
    });
    const run = runJoin(inviteDeps(a, deps.hostMesh.pending), joinerContext(b, a), b.m.identity.noise.publicKey);
    try {
      const asked = await deps.hostMesh.pending.next();
      expect(deps.meshStatus()?.pending).toMatchObject([{ nonce: asked.nonce, code: asked.code }]);
      expect(mesh.read()).toBeUndefined();
      expect(mesh.authorizeIndex()).toBeUndefined();
      deps.hostMesh.pending.decide(asked.nonce, false);
      expect(await failure(run.invited)).toContain("denied");
      expect(deps.meshStatus()).toBeUndefined();
    } finally {
      deps.hostMesh.pending.expireAll();
      await failure(run.invited);
      slots.stop();
      await deps.sync.stop();
    }
  });

  test("a join the inviting member is asked about is in the live facts status reads", () => {
    const { dir, m, mesh } = side("alpha");
    const sessions = new LiveSessions(new DeviceStore(dir), log, mesh);
    const slots = new PairingSlots(new PairingStore(dir, log), m.identity.noise.publicKey, undefined, log);
    stops.push(() => slots.stop());
    const deps = meshDeps({
      stateDir: dir,
      identity: m.identity,
      mesh,
      slots,
      sessions,
      policy: OPEN_POLICY,
      hc: { hc: "hc" },
      relay: { url: undefined },
      program: "/opt/doriface-host",
      log,
    });
    stops.push(() => void deps.sync.stop());
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    const asked = {
      nonce: "n1",
      name: "beta",
      hostId: "host-beta",
      fingerprint: "fp",
      noisePub: "noise-beta",
      expiresAt,
      kind: "machine" as const,
      code: "123 456",
      joinerConfirmed: false,
    };
    void deps.hostMesh.pending.ask(asked);
    expect(deps.hooks.live().pending).toEqual([
      {
        nonce: "n1",
        name: "beta",
        hostId: "host-beta",
        noisePub: "noise-beta",
        expiresAt: new Date(expiresAt),
        kind: "machine" as const,
        code: "123 456",
        joinerConfirmed: false,
      },
    ]);
    deps.hostMesh.pending.expireAll();
  });
});
