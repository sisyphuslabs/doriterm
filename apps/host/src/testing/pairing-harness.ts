import {
  generateHostIdentity,
  generateX25519,
  type InitiatorOptions,
  type PairingSecret,
  pairingSlotOf,
  rawStaticKey,
  type SecureLink,
  secureLink,
} from "@doriface/crypto";
import { type MemoryEnd, memoryLinkPair } from "@doriface/crypto/testing";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptE2ee, type E2eeDeps, type E2eeTransport } from "../e2ee/accept.ts";
import { DeviceStore } from "../state/devices.ts";
import type { MeshStore } from "../state/mesh.ts";
import { PairingStore } from "../state/pairing.ts";

/** A host with a fresh state dir and one open offer, and a way to run one client session against it. */
export function pairingHost(
  options: { readonly mesh?: (dir: string) => MeshStore; readonly meshOffer?: boolean; readonly dir?: string } = {},
) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "dh-accept-"));
  const logs: string[] = [];
  const log = (line: string): void => void logs.push(line);
  const pairing = new PairingStore(dir, log);
  const offer = pairing.offer(Date.now(), options.meshOffer === true);
  const deps: E2eeDeps = {
    identity: generateHostIdentity(),
    devices: new DeviceStore(dir),
    pairing,
    mesh: options.mesh?.(dir),
    log,
    lanUrls: [],
  };
  const relay: E2eeTransport = { kind: "relay", openSlot: pairingSlotOf(offer.code) };
  return { dir, logs, pairing, offer, deps, relay };
}

export type PairingHost = ReturnType<typeof pairingHost>;

export interface SessionRun {
  readonly clientEnd: MemoryEnd;
  readonly hostEnd: MemoryEnd;
  readonly host: Promise<SecureLink | undefined>;
  readonly client: Promise<SecureLink | undefined>;
}

/** One client session against `host` over `transport`; `tap` may rewrite the client's messages in flight. */
export function runSession(
  host: PairingHost,
  transport: E2eeTransport,
  pairing: PairingSecret | undefined,
  extra: Partial<Pick<InitiatorOptions, "testRandomness" | "staticKey" | "stream" | "early">> = {},
  tap?: (bytes: Uint8Array) => readonly Uint8Array[],
): SessionRun {
  const [clientEnd, hostEnd] = memoryLinkPair();
  clientEnd.tap = tap;
  const hostSide = acceptE2ee(hostEnd, host.deps, transport);
  const client = secureLink(clientEnd, {
    role: "initiator",
    hostId: host.deps.identity.hostId,
    staticKey: extra.staticKey ?? rawStaticKey(generateX25519()),
    remoteStatic: host.deps.identity.noise.publicKey,
    pairing,
    stream: extra.stream,
    early: extra.early,
    testRandomness: extra.testRandomness,
  }).then(
    (link) => link,
    () => undefined,
  );
  return { clientEnd, hostEnd, host: hostSide, client };
}

export const codeOf = (host: PairingHost, name = "phone", code = host.offer.code): PairingSecret => ({
  mode: "code",
  code,
  name,
});

export const linkOf = (host: PairingHost, name = "phone"): PairingSecret => ({
  mode: "link",
  linkSecret: host.offer.linkSecret,
  name,
});
