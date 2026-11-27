import { DEFAULT_HANDSHAKE_TIMEOUT_MS } from "@doriface/client";
import { generateX25519, rawStaticKey } from "@doriface/crypto";
import { startHost, type Host } from "@doriface/host";
import { createHcSession, FakeRelay, type HcSession, RelayClientBridge } from "@doriface/host/testing";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PairingOffer, parsePairingFragment } from "../pair/fragment.ts";
import { pairAndRemember, type RememberedHost } from "../pair/handshake.ts";
import { connect } from "./connect.ts";
import { installShellForwarder, type ShellForwarder } from "./direct-forward.test-support.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";

const CLI = join(import.meta.dir, "..", "..", "..", "host", "src", "cli.ts");
const stateDir = mkdtempSync(join(tmpdir(), "dw-direct-budget-"));
const scriptDir = mkdtempSync(join(tmpdir(), "dw-direct-budget-bin-"));
/**
 * While this file exists, every hc the host starts waits before it runs: the core cannot answer a framed hello. The host
 * starts its hc ahead of each session (a pool), so the #640 case raises it before the host starts, not before a
 * connection, and the setup's own pairing never waits (#2614, #2365).
 */
const stalled = join(scriptDir, "stalled");
let slowHc = "";
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
  slowHc = join(scriptDir, "slow-hc.sh");
  // Only the core's sessions (`hc connect`) wait: the host's own checks of the core (its version) run at once.
  writeFileSync(
    slowHc,
    `#!/bin/sh\nif [ "$1" = connect ]; then while [ -e "${stalled}" ]; do sleep 0.05; done; fi\nexec "${hc.hc}" "$@"\n`,
  );
  chmodSync(slowHc, 0o755);
  await startTheHost();
  const { link } = await newOffer();
  const remembered: RememberedHost[] = [];
  await pairAndRemember(link, "phone", (entry) => remembered.push(entry), deps);
  const first = remembered[0];
  if (first === undefined) throw new Error("pairing saved nothing");
  saved = first;
  // The stalled direct race below is the desktop shell's (#1381 §8): its forwarder is what keeps a saved address usable.
  shell = installShellForwarder();
}, 120_000);

/** Starts the host on this file's state, so a restart keeps the pairing; waits until the relay has its answer. */
async function startTheHost(): Promise<void> {
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
}

afterAll(async () => {
  // A case that failed before the relay dialed leaves the hc waiting: let it run so the host can stop it.
  rmSync(stalled, { force: true });
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
  // The host comes back with its core stalled: it proves its key on the direct path, and no hello answer follows.
  writeFileSync(stalled, "");
  await host.stop();
  await startTheHost();
  // The client dials the relay only once it has given up on the direct session. The core is let go at that dial, so
  // the relay session can open, and whether the hello was still stalled then says whether the client waited for it.
  let stalledAtRelayDial: boolean | undefined;
  let relayDialedAfter: number | undefined;
  const started = performance.now();
  const dial = bridge.dialed.push.bind(bridge.dialed);
  bridge.dialed.push = (...urls: URL[]): number => {
    stalledAtRelayDial ??= existsSync(stalled);
    relayDialedAfter ??= performance.now() - started;
    rmSync(stalled, { force: true });
    return dial(...urls);
  };
  // The direct path is off (#2070): the mechanism is tested with the switch on for this test alone.
  const opened = await connect(settingsWith(lanUrl), undefined, deps, { budgetMs: 300, directPath: true });
  expect(opened.path).toBe("relay");
  expect(opened.directReason).toBe("no-answer");
  expect(stalledAtRelayDial).toBe(true);
  // The client gave up on the direct session on its own 300 ms budget: one that waited for the hello would dial the relay
  // only once the connection's default hello deadline ran out. Only this direct part is bounded, not the relay connect
  // a loaded machine slows (#2614).
  expect(relayDialedAfter).toBeLessThan(DEFAULT_HANDSHAKE_TIMEOUT_MS / 2);
  opened.connection.close();
}, 60_000);
