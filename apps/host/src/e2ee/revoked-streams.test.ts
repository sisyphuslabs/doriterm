import { base64urlEncode, CloseCode, generateX25519, rawStaticKey } from "@doriface/crypto";
import { encodePushLine, parsePushHostLine } from "@doriface/protocol";
import { afterAll, beforeAll, expect, mock, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateToken } from "../auth.ts";
import type { Host } from "../host.ts";
import { DeviceStore } from "../state/devices.ts";
import { loadHostIdentity } from "../state/host-keys.ts";
import { openE2eeClient } from "../testing/e2ee-client.ts";
import { createHcSession, type HcSession } from "../testing/hc-session.ts";

// The per-chunk check alone, on a real host, with the revocation watch down (#2530): a watch that cannot start or
// misses an event must not leave a revoked device served on any of its streams.
// bun's mock.module is process-wide: the real module is restored once this file's host has stopped, so later files in the
// same `bun test` run get the real watch.
const realWatch = { ...(await import("./revocation-watch.ts")) };
await mock.module("./revocation-watch.ts", () => ({ watchRevocations: () => () => undefined }));
const { startHost } = await import("../host.ts");

setDefaultTimeout(30_000);
const stateDir = mkdtempSync(join(tmpdir(), "dh-revoked-streams-"));
let session: HcSession;
let host: Host;

beforeAll(async () => {
  session = createHcSession("doriface-revoked-streams-test");
  host = await startHost({
    listen: { hostname: "127.0.0.1", port: 0 },
    token: generateToken(),
    hc: session.hc,
    session: session.name,
    env: session.env,
    stateDir,
    log: () => undefined,
  });
});

afterAll(async () => {
  await host.stop();
  await mock.module("./revocation-watch.ts", () => realWatch);
  await session.dispose();
  rmSync(stateDir, { recursive: true, force: true });
});

test("a device revoked from another process gets no reply on its open push stream, which closes 4401", async () => {
  const e2ee = host.e2ee;
  if (e2ee === undefined) throw new Error("the host has no e2ee endpoint");
  const identity = loadHostIdentity(stateDir);
  const key = generateX25519();
  const devices = new DeviceStore(stateDir);
  devices.add(key.publicKey, "phone");
  const client = await openE2eeClient(e2ee.url, {
    hostId: identity.hostId,
    staticKey: rawStaticKey(key),
    remoteStatic: identity.noise.publicKey,
    stream: "push",
  });
  try {
    const hello = new TextEncoder().encode(encodePushLine({ t: "hello" }));
    client.link.send(hello);
    expect(parsePushHostLine(new TextDecoder().decode(await client.reader.line()))).toMatchObject({ t: "ready" });
    expect(devices.revoke(base64urlEncode(key.publicKey))).toHaveLength(1);
    const replied = client.reader.line().then(
      () => "replied" as const,
      () => "ended" as const,
    );
    client.link.send(hello);
    expect(await Promise.race([client.closed, replied])).toBe(CloseCode.UnknownDevice);
  } finally {
    client.link.close();
    await client.closed;
  }
});
