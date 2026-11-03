import { base64urlEncode } from "@doriface/crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MeshHost } from "./mesh-host.ts";

const FILE = "devices.json";

const keysIn = (value: unknown): readonly string[] => {
  if (typeof value !== "object" || value === null || !("devices" in value) || !Array.isArray(value.devices)) return [];
  return value.devices.flatMap((entry: unknown) =>
    typeof entry === "object" &&
    entry !== null &&
    "clientStaticPub" in entry &&
    typeof entry.clientStaticPub === "string"
      ? [entry.clientStaticPub]
      : [],
  );
};

/** The device keys in this host's `devices.json` (base64url), as the host reads them on every handshake. */
export function deviceKeys(host: MeshHost): readonly string[] {
  const path = join(host.stateDir, FILE);
  return existsSync(path) ? keysIn(JSON.parse(readFileSync(path, "utf8"))) : [];
}

/**
 * Writes paired-device entries for these keys straight into `devices.json`, as a stale entry from before the
 * mesh (or one added behind the host's back) would sit there. Section 6.7 says a revoke must remove the ones that are
 * a revoked member's Noise key.
 */
export function seedDevices(
  host: MeshHost,
  devices: readonly { readonly key: Uint8Array; readonly name: string }[],
): void {
  const entries = devices.map((device) => ({
    clientStaticPub: base64urlEncode(device.key),
    name: device.name,
    pairedAt: new Date(0).toISOString(),
  }));
  writeFileSync(join(host.stateDir, FILE), `${JSON.stringify({ version: 1, devices: entries })}\n`, { mode: 0o600 });
}
