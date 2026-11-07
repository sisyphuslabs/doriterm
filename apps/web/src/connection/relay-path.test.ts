import { base64urlEncode, generateX25519, rawStaticKey } from "@doriface/crypto";
import { startHost, type Host } from "@doriface/host";
import { createHcSession, FakeRelay, type HcSession, RelayClientBridge } from "@doriface/host/testing";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { offerFrom, type PairingOffer, parsePairingFragment } from "../pair/fragment.ts";
import { PairingFailedError, pairAndOpen, pairAndRemember, type RememberedHost } from "../pair/handshake.ts";
import { connect } from "./connect.ts";
import { MeshConnections } from "./mesh-connections.ts";
import { ConnectionStore } from "./store.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";

const CLI = join(import.meta.dir, "..", "..", "..", "host", "src", "cli.ts");
const stateDir = mkdtempSync(join(tmpdir(), "dw-relay-path-"));
const device = rawStaticKey(generateX25519());
const deps = { loadDeviceKey: () => Promise.resolve(device) };
let relay: FakeRelay;
let bridge: RelayClientBridge;
let hc: HcSession;
let host: Host;

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

function codeOffer(link: PairingOffer, code: string): PairingOffer {
  const parsed = offerFrom(link, { mode: "code", code }, { relayUrl: bridge.url, target: "device" });
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.offer;
}

beforeAll(async () => {
  relay = new FakeRelay();
  bridge = new RelayClientBridge(relay);
  hc = createHcSession("doriface-web-relay-path");
  host = await startHost({
    listen: { hostname: "127.0.0.1", port: 0 },
    token: "web-relay-path-token-web-relay-path-token-web",
    hc: hc.hc,
    session: hc.name,
    env: hc.env,
    stateDir,
    relay: { url: relay.url },
    log: () => {},
  });
  await relay.answers.next();
}, 30_000);

afterAll(async () => {
  await host.stop();
  await bridge.stop();
  await relay.stop();
  await hc.dispose();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("the web relay path against a real doriface-host", () => {
  test("a wrong typed code fails pairing and saves nothing", async () => {
    const { link, code } = await newOffer();
    const wrong = `${code.slice(0, 3)}${code.slice(3) === "00000" ? "11111" : "00000"}`;
    const saved: RememberedHost[] = [];
    const failure = await pairAndRemember(
      codeOffer(link, wrong),
      "guess",
      (remembered) => saved.push(remembered),
      deps,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(PairingFailedError);
    expect(saved).toEqual([]);
  }, 30_000);

  test("a typed code dials ?pair=<slot>, pairs, and only then saves the host", async () => {
    const { link, code } = await newOffer();
    const saved: RememberedHost[] = [];
    await pairAndRemember(codeOffer(link, code), "phone", (remembered) => saved.push(remembered), deps);
    expect(bridge.dialed.at(-1)?.searchParams.get("pair")).toBe(code.slice(0, 3));
    expect(saved).toEqual([
      { hostId: link.hostId, hostKey: base64urlEncode(link.noiseStaticPub), relayUrl: bridge.url },
    ]);
  }, 30_000);

  test("pairing opens the workspace on the session it proved: one relay socket from They match to open (#1271)", async () => {
    const { link } = await newOffer();
    // A test build is not a dev build, so the store would lock its relay to production: the dial keeps this test's relay.
    const dial: typeof connect = (settings, signal, _deps, options) =>
      connect({ ...settings, relayUrl: bridge.url }, signal, deps, options);
    const connections = new MeshConnections({ ...DEFAULT_SETTINGS, relayUrl: bridge.url }, (settings, save) => {
      return new ConnectionStore(settings, dial, save);
    });
    const opened = new Promise<void>((resolve) => {
      connections.subscribe(() => {
        if (connections.state.phase === "open") resolve();
      });
    });
    const dialsBefore = bridge.dialed.length;
    try {
      await pairAndOpen(link, "laptop", connections, deps);
      await opened;
      expect(bridge.dialed.length - dialsBefore).toBe(1);
      const { state } = connections;
      if (state.phase !== "open") throw new Error(`the workspace connection is ${state.phase}`);
      expect((await state.connection.call("terminal.list", {})).terminals).toBeArray();
    } finally {
      connections.stop();
    }
  }, 30_000);

  test("a link dials an ordinary session and pairs; connect() then runs hello over Noise IK", async () => {
    const { link } = await newOffer();
    const saved: RememberedHost[] = [];
    await pairAndRemember(link, "laptop", (remembered) => saved.push(remembered), deps);
    expect(bridge.dialed.at(-1)?.searchParams.has("pair")).toBe(false);
    const remembered = saved[0];
    if (remembered === undefined) throw new Error("the link pairing saved nothing");
    const opened = await connect({ ...DEFAULT_SETTINGS, mode: "relay", ...remembered }, undefined, deps);
    expect(opened.path).toBe("relay");
    expect(opened.connection.hello.framed).toBe(true);
    opened.connection.close();
  }, 30_000);
});
