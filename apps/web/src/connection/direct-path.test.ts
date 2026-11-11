import { generateX25519, rawStaticKey } from "@doriface/crypto";
import { startHost, type Host } from "@doriface/host";
import { createHcSession, FakeRelay, type HcSession, RelayClientBridge } from "@doriface/host/testing";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PairingOffer, parsePairingFragment } from "../pair/fragment.ts";
import { pairAndRemember, type RememberedHost } from "../pair/handshake.ts";
import { connect, type OpenConnection, type OpenOptions } from "./connect.ts";
import { installShellForwarder, type ShellForwarder } from "./direct-forward.test-support.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";

// The direct path is off (#2070): these are the mechanism's tests, run with the switch on for the test alone, so the
// path a later decision may turn back on stays proven. relay-only.test.ts proves the default.
const ON: OpenOptions = { directPath: true };

const CLI = join(import.meta.dir, "..", "..", "..", "host", "src", "cli.ts");
const stateDir = mkdtempSync(join(tmpdir(), "dw-direct-path-"));
const otherStateDir = mkdtempSync(join(tmpdir(), "dw-direct-path-other-"));
const device = rawStaticKey(generateX25519());
const deps = { loadDeviceKey: () => Promise.resolve(device) };
let relay: FakeRelay;
let bridge: RelayClientBridge;
let hc: HcSession;
let host: Host;
let other: Host;
let saved: RememberedHost;
let shell: ShellForwarder | undefined;
let lanUrl: string;
let otherLanUrl: string;

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

/** A port nothing listens on: bound once and released, so connecting to it is refused at once. */
async function closedPort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) throw new Error("the probe listener named no port");
  return port;
}

/** A listener that accepts the socket and never answers, as a host that is there but not awake does. */
function silentListener(): { readonly url: string; readonly stop: () => void } {
  const server = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data: () => undefined, open: () => undefined, close: () => undefined },
  });
  return { url: `ws://127.0.0.1:${server.port}/v1/e2ee`, stop: () => void server.stop(true) };
}

function relayDials(): number {
  return bridge.dialed.length;
}

beforeAll(async () => {
  relay = new FakeRelay();
  bridge = new RelayClientBridge(relay);
  hc = createHcSession("doriface-web-direct-path");
  host = await startHost({
    listen: { hostname: "127.0.0.1", port: 0 },
    lanListen: { hostname: "127.0.0.1", port: 0 },
    token: "web-direct-path-token-web-direct-path-token-web",
    hc: hc.hc,
    session: hc.name,
    env: hc.env,
    stateDir,
    relay: { url: relay.url },
    log: () => {},
  });
  other = await startHost({
    listen: { hostname: "127.0.0.1", port: 0 },
    lanListen: { hostname: "127.0.0.1", port: 0 },
    token: "web-direct-path-other-token-web-direct-path",
    hc: hc.hc,
    session: hc.name,
    env: hc.env,
    stateDir: otherStateDir,
    log: () => {},
  });
  await relay.answers.next();
  lanUrl = host.e2ee?.lanUrls[0] ?? "";
  otherLanUrl = other.e2ee?.lanUrls[0] ?? "";
  if (lanUrl === "" || otherLanUrl === "") throw new Error("a host with a LAN listener named no direct URL");
  const { link } = await newOffer();
  const remembered: RememberedHost[] = [];
  await pairAndRemember(link, "phone", (entry) => remembered.push(entry), deps);
  const first = remembered[0];
  if (first === undefined) throw new Error("pairing saved nothing");
  saved = first;
  // These are the desktop shell's sessions (#1381 §8): its forwarder is what keeps a saved address usable at all.
  shell = installShellForwarder();
}, 60_000);

afterAll(async () => {
  shell?.restore();
  await host.stop();
  await other.stop();
  await bridge.stop();
  await relay.stop();
  await hc.dispose();
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(otherStateDir, { recursive: true, force: true });
});

/** The paired host's settings, with `directUrl` as the person saved it. */
function settingsWith(directUrl: string): typeof DEFAULT_SETTINGS {
  return { ...DEFAULT_SETTINGS, ...saved, mode: "relay", relayUrl: bridge.url, directUrl };
}

describe("with the direct path switched on, the desktop shell uses a saved direct address with the relay as its fallback (#446, #1381 §8, #2070)", () => {
  test("an address that answers carries the session, and the relay is never dialed", async () => {
    const before = relayDials();
    const opened: OpenConnection = await connect(settingsWith(lanUrl), undefined, deps, ON);
    expect(opened.path).toBe("direct");
    expect(opened.connection.hello.framed).toBe(true);
    expect(relayDials()).toBe(before);
    opened.connection.close();
  }, 30_000);

  test("an address that nothing answers reaches the host through the relay at once", async () => {
    const url = `ws://127.0.0.1:${await closedPort()}/v1/e2ee`;
    const opened = await connect(settingsWith(url), undefined, deps, ON);
    expect(opened.path).toBe("relay");
    expect(opened.connection.hello.framed).toBe(true);
    opened.connection.close();
  }, 30_000);

  test("an address that accepts and never answers spends the budget, then the relay carries the session", async () => {
    const silent = silentListener();
    const started = performance.now();
    try {
      const opened = await connect(settingsWith(silent.url), undefined, deps, ON);
      const elapsed = performance.now() - started;
      expect(opened.path).toBe("relay");
      expect(opened.directReason).toBe("no-answer");
      expect(elapsed).toBeLessThan(3_000);
      opened.connection.close();
    } finally {
      silent.stop();
    }
  }, 30_000);

  test("a host that cannot prove the pinned key is refused, and the relay carries the session", async () => {
    const opened = await connect(settingsWith(otherLanUrl), undefined, deps, ON);
    expect(opened.path).toBe("relay");
    expect(opened.directReason).toBe("authentication-failed");
    opened.connection.close();
  }, 30_000);

  test("an address a secure page may not open is never dialed: the relay carries the session", async () => {
    const opened = await connect(settingsWith("ws://192.0.2.10:7767"), undefined, deps, {
      ...ON,
      page: { secureContext: true, forwardsPlainWs: false },
    });
    expect(opened.path).toBe("relay");
    expect(opened.directReason).toBe("blocked");
    opened.connection.close();
  }, 30_000);

  test("an address naming another path is never dialed: the relay carries the session", async () => {
    const opened = await connect(settingsWith("ws://192.0.2.10:7767/v1/hc"), undefined, deps, ON);
    expect(opened.path).toBe("relay");
    expect(opened.directReason).toBe("unusable-address");
    opened.connection.close();
  }, 30_000);

  test("an attempt that must go to the relay does not race the address again", async () => {
    const before = relayDials();
    const opened = await connect(settingsWith(lanUrl), undefined, deps, { ...ON, skipDirect: true });
    expect(opened.path).toBe("relay");
    expect(relayDials()).toBe(before + 1);
    opened.connection.close();
  }, 30_000);

  test("no direct address set dials the relay, as before", async () => {
    const opened = await connect(settingsWith(""), undefined, deps, ON);
    expect(opened.path).toBe("relay");
    expect(opened.directReason).toBeUndefined();
    opened.connection.close();
  }, 30_000);
});
