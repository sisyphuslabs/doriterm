import { generateX25519, rawStaticKey } from "@doriface/crypto";
import { startHost, type Host } from "@doriface/host";
import { createHcSession, FakeRelay, type HcSession, RelayClientBridge } from "@doriface/host/testing";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PairingOffer, parsePairingFragment } from "../pair/fragment.ts";
import { pairAndRemember, type RememberedHost } from "../pair/handshake.ts";
import { connect } from "./connect.ts";
import { installShellForwarder, type ShellForwarder } from "./direct-forward.test-support.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";

const CLI = join(import.meta.dir, "..", "..", "..", "host", "src", "cli.ts");
/**
 * How long this fixture's core takes to answer, so the framed hello is still in flight when the direct budget runs out.
 * Long, so a client that waited for it is told apart from a slow relay connect on a loaded runner (#2614).
 */
const STALL_MS = 20_000;
const stateDir = mkdtempSync(join(tmpdir(), "dw-direct-budget-"));
const scriptDir = mkdtempSync(join(tmpdir(), "dw-direct-budget-bin-"));
const device = rawStaticKey(generateX25519());
const deps = { loadDeviceKey: () => Promise.resolve(device) };
let relay: FakeRelay;
let bridge: RelayClientBridge;
let hc: HcSession;
let host: Host;
let saved: RememberedHost;
let shell: ShellForwarder | undefined;
let lanUrl: string;

async function newOffer(): Promise<{ readonly link: PairingOffer; readonly code: string }> {
  const args = ["pair", "--no-qr", "--web-origin", "https://web.example", "--state-dir", stateDir];
  const proc = Bun.spawn([process.execPath, CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const url = stdout.split("\n").find((line) => line.startsWith("https://web.example/pair#"));
  const code = /^code\s+(\S{4}) (\S{4})/m.exec(stdout);
  const parsed = parsePairingFragment(new URL(url ?? "https://x").hash);
  if ((await proc.exited) !== 0 || code === null || !parsed.ok) throw new Error(`pair failed: ${stdout}`);
  return { link: { ...parsed.offer, relayUrl: bridge.url }, code: `${code[1]}${code[2]}` };
}

beforeAll(async () => {
  relay = new FakeRelay();
  bridge = new RelayClientBridge(relay);
  hc = createHcSession("doriface-web-direct-budget");
  const slowHc = join(scriptDir, "slow-hc.sh");
  writeFileSync(slowHc, `#!/bin/sh\nsleep ${STALL_MS / 1000}\nexec "${hc.hc}" "$@"\n`);
  chmodSync(slowHc, 0o755);
  host = await startHost({
    listen: { hostname: "127.0.0.1", port: 0 },
    lanListen: { hostname: "127.0.0.1", port: 0 },
    token: "web-direct-budget-token-web-direct-budget-web",
    hc: slowHc,
    session: hc.name,
    env: hc.env,
    stateDir,
    relay: { url: relay.url },
    log: () => {},
  });
  await relay.answers.next();
  lanUrl = host.e2ee?.lanUrls[0] ?? "";
  if (lanUrl === "") throw new Error("a host with a LAN listener named no direct URL");
  const { link } = await newOffer();
  const remembered: RememberedHost[] = [];
  await pairAndRemember(link, "phone", (entry) => remembered.push(entry), deps);
  const first = remembered[0];
  if (first === undefined) throw new Error("pairing saved nothing");
  saved = first;
  // The stalled direct race below is the desktop shell's (#1381 §8): its forwarder is what keeps a saved address usable.
  shell = installShellForwarder();
}, 120_000);

afterAll(async () => {
  shell?.restore();
  await host.stop();
  await bridge.stop();
  await relay.stop();
  await hc.dispose();
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(scriptDir, { recursive: true, force: true });
});

const settingsWith = (directUrl: string): typeof DEFAULT_SETTINGS => ({
  ...DEFAULT_SETTINGS,
  ...saved,
  mode: "relay",
  relayUrl: bridge.url,
  directUrl,
});

test("the desktop shell's host that proves its key and then stalls the hello is not a session: the relay carries it inside the budget (#640)", async () => {
  const started = performance.now();
  const opened = await connect(settingsWith(lanUrl), undefined, deps, { budgetMs: 300 });
  const elapsed = performance.now() - started;
  expect(opened.path).toBe("relay");
  expect(opened.directReason).toBe("no-answer");
  // Waiting for the stalled hello would take at least the stall; a relay connect, however slow, finishes well inside it.
  expect(elapsed).toBeLessThan(STALL_MS);
  opened.connection.close();
}, 60_000);
