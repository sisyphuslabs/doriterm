import { generateX25519, rawStaticKey } from "@doriface/crypto";
import { startHost, type Host } from "@doriface/host";
import { createHcSession, FakeRelay, type HcSession, RelayClientBridge } from "@doriface/host/testing";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PairingOffer, parsePairingFragment } from "../pair/fragment.ts";
import { pairAndRemember, type RememberedHost } from "../pair/handshake.ts";
import { connect, type OpenConnection } from "./connect.ts";
import { installShellForwarder } from "./direct-forward.test-support.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";

// #1381 §8: a browser reaches every member over the relay. A saved direct address is a file an older build (or the
// desktop shell) wrote and is kept for it, but a browser never dials it; the desktop shell keeps its direct race.

const CLI = join(import.meta.dir, "..", "..", "..", "host", "src", "cli.ts");
const TOKEN = "web-relay-only-token-web-relay-only-token-web";
const stateDir = mkdtempSync(join(tmpdir(), "dw-relay-only-"));
const device = rawStaticKey(generateX25519());
const deps = { loadDeviceKey: () => Promise.resolve(device) };
let relay: FakeRelay;
let bridge: RelayClientBridge;
let hc: HcSession;
let host: Host;
let saved: RememberedHost;
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

/** A listener that answers no WebSocket and counts every socket opened to it, so a direct dial is a fact, not an absence. */
function dialCanary(): { readonly url: string; readonly opened: () => number; readonly stop: () => void } {
  let sockets = 0;
  const server = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open: () => {
        sockets += 1;
      },
      data: () => undefined,
      close: () => undefined,
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}/v1/e2ee`,
    opened: () => sockets,
    stop: () => void server.stop(true),
  };
}

beforeAll(async () => {
  relay = new FakeRelay();
  bridge = new RelayClientBridge(relay);
  hc = createHcSession("doriface-web-relay-only");
  host = await startHost({
    listen: { hostname: "127.0.0.1", port: 0 },
    lanListen: { hostname: "127.0.0.1", port: 0 },
    token: TOKEN,
    hc: hc.hc,
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
}, 60_000);

afterAll(async () => {
  await host.stop();
  await bridge.stop();
  await relay.stop();
  await hc.dispose();
  rmSync(stateDir, { recursive: true, force: true });
});

/** The paired host's settings, with `directUrl` as a file an older build or the shell left it. */
function settingsWith(directUrl: string): typeof DEFAULT_SETTINGS {
  return { ...DEFAULT_SETTINGS, ...saved, mode: "relay", relayUrl: bridge.url, directUrl };
}

const relayDials = (): number => bridge.dialed.length;

describe("a browser has no direct path (#1381 §8)", () => {
  test("a saved direct address is ignored: no socket is dialled, and the relay carries the session", async () => {
    const canary = dialCanary();
    try {
      const before = relayDials();
      const opened: OpenConnection = await connect(settingsWith(canary.url), undefined, deps);
      // No reason means no attempt at all: every failed direct attempt says why it failed.
      expect(opened.path).toBe("relay");
      expect(opened.directReason).toBeUndefined();
      expect(canary.opened()).toBe(0);
      expect(relayDials()).toBe(before + 1);
      expect(opened.connection.hello.framed).toBe(true);
      opened.connection.close();
    } finally {
      canary.stop();
    }
  }, 30_000);

  test("the loopback gateway of a page served on this computer still opens", async () => {
    const loopback = { ...DEFAULT_SETTINGS, mode: "loopback" as const, loopbackUrl: host.url, token: TOKEN };
    const opened = await connect(loopback, undefined, deps);
    expect(opened.path).toBe("loopback");
    expect(opened.connection.hello.framed).toBe(true);
    opened.connection.close();
  }, 30_000);

  test("a member with no saved direct address is never dialled direct, on either surface", async () => {
    const browser = await connect(settingsWith(""), undefined, deps);
    expect(browser.path).toBe("relay");
    expect(browser.directReason).toBeUndefined();
    browser.connection.close();

    const shell = installShellForwarder();
    try {
      const inShell = await connect(settingsWith(""), undefined, deps);
      expect(inShell.path).toBe("relay");
      expect(inShell.directReason).toBeUndefined();
      expect(shell.targets).toEqual([]);
      inShell.connection.close();
    } finally {
      shell.restore();
    }
  }, 30_000);
});

describe("the desktop shell keeps the direct path it had (#446)", () => {
  test("with the forwarder present, the paired host still races direct and the relay is not dialled", async () => {
    const shell = installShellForwarder();
    try {
      const before = relayDials();
      const opened = await connect(settingsWith(lanUrl), undefined, deps);
      expect(opened.path).toBe("direct");
      expect(opened.connection.hello.framed).toBe(true);
      expect(relayDials()).toBe(before);
      opened.connection.close();
    } finally {
      shell.restore();
    }
    // The same address with no forwarder is a browser's: the relay carries it, and nothing was dialled direct.
    const browser = await connect(settingsWith(lanUrl), undefined, deps);
    expect(browser.path).toBe("relay");
    expect(browser.directReason).toBeUndefined();
    browser.connection.close();
  }, 30_000);
});
