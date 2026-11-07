import { CloseCode, generateX25519, parsePairingUrl, rawStaticKey } from "@doriface/crypto";
import { parsePolicy } from "@doriface/policy";
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateToken } from "./auth.ts";
import { type Host, startHost } from "./host.ts";
import { openE2eeClient } from "./testing/e2ee-client.ts";
import { createHcSession, HELLO, type HcSession } from "./testing/hc-session.ts";

const CLI = join(import.meta.dir, "cli.ts");
setDefaultTimeout(30_000);
const stateDir = mkdtempSync(join(tmpdir(), "dh-pair-limit-"));
let session: HcSession;
let host: Host;

async function linkOffer(): Promise<ReturnType<typeof parsePairingUrl>> {
  const args = ["pair", "--no-qr", "--web-origin", "https://web.example", "--state-dir", stateDir];
  const proc = Bun.spawn([process.execPath, CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const url = stdout.split("\n").find((line) => line.startsWith("https://web.example/pair#"));
  if (code !== 0 || url === undefined) throw new Error(`pair failed: ${stdout}`);
  return parsePairingUrl(url);
}

const endpoint = (): string => {
  const url = host.e2ee?.url;
  if (url === undefined) throw new Error("the host has no e2ee endpoint");
  return url;
};

const pairing = (offer: ReturnType<typeof parsePairingUrl>, name: string, key = generateX25519()) =>
  openE2eeClient(endpoint(), {
    hostId: offer.hostId,
    staticKey: rawStaticKey(key),
    remoteStatic: offer.noiseStaticPub,
    pairing: { mode: "link", linkSecret: offer.linkSecret, name },
  });

beforeAll(async () => {
  session = createHcSession("doriface-pair-limit-test");
  host = await startHost({
    listen: { hostname: "127.0.0.1", port: 0 },
    token: generateToken(),
    hc: session.hc,
    session: session.name,
    env: session.env,
    stateDir,
    lanListen: { hostname: "127.0.0.1", port: 0 },
    policy: parsePolicy('{"plan":"free","limits":{"sessions":1}}'),
    log: () => undefined,
  });
});

afterAll(async () => {
  await host.stop();
  await session.dispose();
  rmSync(stateDir, { recursive: true, force: true });
});

test("a pairing at the plan's session limit pairs and answers hello, then closes 4429 instead of staying open as a workspace (#1271)", async () => {
  const first = generateX25519();
  const firstOffer = await linkOffer();
  // The first device pairs and keeps its pairing session as its workspace: the host's one session.
  const workspace = await pairing(firstOffer, "laptop", first);
  workspace.link.send(HELLO);
  await workspace.reader.line();

  const second = await pairing(await linkOffer(), "phone");
  second.link.send(HELLO);
  expect(JSON.parse(new TextDecoder().decode(await second.reader.line())).result.framed).toBe(true);
  const closed = await Promise.race([second.closed, Bun.sleep(5_000).then(() => "still open")]);
  expect(closed).toBe(CloseCode.RateLimited);
  workspace.link.close();
});
