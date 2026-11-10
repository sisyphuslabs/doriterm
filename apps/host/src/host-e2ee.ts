import type { HostIdentity } from "@doriface/crypto";
import type { RelayProofs } from "@doriface/relay-client";
import { policyFromEnv } from "@doriface/policy";
import { LiveSessions } from "./e2ee/sessions.ts";
import type { HostOptions } from "./host-types.ts";
import { meshDeps } from "./mesh/host-deps.ts";
import { type PairingSlotRegistrar, PairingSlots } from "./pairing-slots.ts";
import { DeviceStore } from "./state/devices.ts";
import { MeshStore } from "./state/mesh.ts";
import { PairingStore } from "./state/pairing.ts";

export function e2eeDeps(
  stateDir: string,
  identity: HostIdentity,
  registrar: PairingSlotRegistrar | undefined,
  options: HostOptions,
  proofs: RelayProofs | undefined,
) {
  const devices = new DeviceStore(stateDir);
  const policy = options.policy ?? policyFromEnv(process.env);
  const pairing = new PairingStore(stateDir, options.log);
  const mesh = new MeshStore(stateDir, { log: options.log });
  mesh.ensureIndex();
  /** Filled in once the LAN listener has its port. */
  const lanUrls: string[] = [];
  const slots = new PairingSlots(pairing, identity.noise.publicKey, registrar, options.log);
  const sessions = new LiveSessions(devices, options.log, mesh);
  const meshParts = meshDeps({
    stateDir,
    identity,
    mesh,
    slots,
    sessions,
    policy,
    hc: {
      hc: options.hc,
      session: options.session,
      env: options.env,
      handshakeTimeoutMs: options.hcHandshakeTimeoutMs,
    },
    relay: { url: options.relay?.url, createSocket: options.relay?.createSocket, proofs },
    program: options.meshProgram,
    hooks: options.meshHooks,
    log: options.log,
  });
  return {
    identity,
    lanUrls,
    devices,
    pairing,
    mesh,
    slots,
    sessions,
    policy,
    live: { count: () => sessions.count() },
    ...meshParts,
    rekeyInterval: options.rekeyInterval,
    log: options.log,
  };
}
