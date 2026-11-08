import { afterEach, describe, expect, test } from "bun:test";
import { PAIRING_TTL_MS } from "@doriface/crypto";
import { OPEN_POLICY } from "@doriface/policy";
import { LiveSessions } from "../e2ee/sessions.ts";
import { PairingSlots } from "../pairing-slots.ts";
import { DeviceStore } from "../state/devices.ts";
import { PairingStore } from "../state/pairing.ts";
import { removeSides, side } from "../testing/join-harness.ts";
import { meshDeps } from "./host-deps.ts";
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  removeSides();
});
const log = () => {};

describe("the running host's pending joins in mesh status (section 4.3)", () => {
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
