import { generateX25519, rawStaticKey } from "@doriface/crypto";
import { startHost, type Host } from "@doriface/host";
import { createHcSession, FakeRelay, type HcSession, RelayClientBridge } from "@doriface/host/testing";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installShellForwarder } from "../connection/direct-forward.test-support.ts";
import { type ConnectionSettings, DEFAULT_SETTINGS } from "../connection/settings.ts";
import { type PairingOffer, parsePairingFragment } from "../pair/fragment.ts";
import { pairAndRemember, type RememberedHost } from "../pair/handshake.ts";
import type { KeyValueStore } from "../storage/idb.ts";
import { loadPushRoute, openPushLink, type PushRoute, routeOf, savePushRoute } from "./push-route.ts";

// #2070: the direct path is off, so the push stream is the relay's everywhere. #1381 §8: a browser's was already;
// only the desktop shell could dial a saved direct address for it, and a service worker has no shell bridge at all. A
// route an older build stored keeps its address, which nothing dials; the shell's race stays behind the switch.

const CLI = join(import.meta.dir, "..", "..", "..", "host", "src", "cli.ts");
const DIRECT = "ws://192.0.2.10:7767/v1/e2ee";
const stateDir = mkdtempSync(join(tmpdir(), "dw-push-route-"));
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

function memoryStore(): KeyValueStore {
  const values = new Map<string, unknown>();
  return {
    get: (key) => Promise.resolve(values.get(key)),
    put: async (key, value) => {
      values.set(key, value);
    },
  };
}

beforeAll(async () => {
  relay = new FakeRelay();
  bridge = new RelayClientBridge(relay);
  hc = createHcSession("doriface-web-push-route");
  host = await startHost({
    listen: { hostname: "127.0.0.1", port: 0 },
    lanListen: { hostname: "127.0.0.1", port: 0 },
    token: "web-push-route-token-web-push-route-token",
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

/** A push route to the paired host with `directUrl` in it, as an older build stored it. */
const relayRoute = (directUrl: string): Extract<PushRoute, { readonly mode: "relay" }> => ({
  mode: "relay",
  relayUrl: bridge.url,
  hostId: saved.hostId,
  hostKey: saved.hostKey,
  directUrl,
});

const settingsWith = (directUrl: string): ConnectionSettings => ({
  ...DEFAULT_SETTINGS,
  ...saved,
  mode: "relay",
  relayUrl: bridge.url,
  directUrl,
});

const relayDials = (): number => bridge.dialed.length;

describe("a browser's push stream is the relay's (#1381 §8)", () => {
  test("a saved direct address is never dialled, and the relay carries the push session", async () => {
    const canary = dialCanary();
    try {
      const before = relayDials();
      const link = await openPushLink(relayRoute(canary.url), { deps });
      expect(canary.opened()).toBe(0);
      expect(relayDials()).toBe(before + 1);
      link.close();
    } finally {
      canary.stop();
    }
  }, 30_000);

  test("a route an older build stored keeps its direct address, and a browser ignores it", async () => {
    const canary = dialCanary();
    try {
      const store = memoryStore();
      await store.put("push-route", relayRoute(canary.url));
      const stored = await loadPushRoute(store);
      if (stored === undefined) throw new Error("the stored push route did not load");
      expect(stored).toEqual(relayRoute(canary.url));
      const before = relayDials();
      const link = await openPushLink(stored, { deps });
      expect(canary.opened()).toBe(0);
      expect(relayDials()).toBe(before + 1);
      link.close();
    } finally {
      canary.stop();
    }
  }, 30_000);

  test("the route this app builds leaves the direct address out, in a browser and in the shell alike (#2070)", () => {
    const relayOnly: PushRoute = { mode: "relay", relayUrl: bridge.url, hostId: saved.hostId, hostKey: saved.hostKey };
    expect(routeOf(settingsWith(DIRECT))).toEqual(relayOnly);

    const shell = installShellForwarder();
    try {
      expect(routeOf(settingsWith(DIRECT))).toEqual(relayOnly);
      // Only with the direct path switched on does the shell's route keep the address.
      expect(routeOf(settingsWith(DIRECT), true)).toEqual({ ...relayOnly, directUrl: DIRECT });
    } finally {
      shell.restore();
    }
  });

  test("a saved route leaves the direct address out, in a browser and in the shell alike (#2070)", async () => {
    const store = memoryStore();
    const relayOnly: PushRoute = { mode: "relay", relayUrl: bridge.url, hostId: saved.hostId, hostKey: saved.hostKey };
    await savePushRoute(relayRoute(DIRECT), store);
    expect(await loadPushRoute(store)).toEqual(relayOnly);

    const shell = installShellForwarder();
    try {
      await savePushRoute(relayRoute(DIRECT), store);
      expect(await loadPushRoute(store)).toEqual(relayOnly);
      // Only with the direct path switched on does the shell's saved route keep the address.
      await savePushRoute(relayRoute(DIRECT), store, true);
      expect(await loadPushRoute(store)).toMatchObject({ directUrl: DIRECT });
    } finally {
      shell.restore();
    }
  });
});

describe("the desktop shell's direct push race stays behind the switch (#446, #2070)", () => {
  test("with the forwarder present and the switch off, the push session is the relay's and no socket goes to the address", async () => {
    const shell = installShellForwarder();
    const canary = dialCanary();
    try {
      const before = relayDials();
      const link = await openPushLink(relayRoute(canary.url), { deps });
      expect(canary.opened()).toBe(0);
      expect(relayDials()).toBe(before + 1);
      link.close();
    } finally {
      canary.stop();
      shell.restore();
    }
  }, 30_000);

  test("switched on for this test, the push session opens on the host's own listener, and the relay is not dialled", async () => {
    const shell = installShellForwarder();
    try {
      const before = relayDials();
      const link = await openPushLink(relayRoute(lanUrl), { deps, directPath: true });
      expect(relayDials()).toBe(before);
      link.close();
    } finally {
      shell.restore();
    }
  }, 30_000);
});
