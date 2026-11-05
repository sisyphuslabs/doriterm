import { HcConnection } from "@doriface/client";
import {
  type KeyPair,
  type PairingSecret,
  parsePairingUrl,
  rawStaticKey,
  type SecureLink,
  secureLink,
} from "@doriface/crypto";
import { deviceIdOf, DeviceStore, type Host, startHost } from "@doriface/host";
import { connectRelayClient, type CreateSocket, pairSlotOf } from "@doriface/relay-client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestControl } from "../../../apps/host/src/control.ts";
import { createHcSession, type HcSession } from "../../../apps/host/src/testing/hc-session.ts";
import { RecordingLink, type Tap, taps, tappedHc } from "./byte-tap.ts";
import { socketFrom, testIp } from "./probe.ts";
import { type LocalRelay, startLocalRelay } from "./relay-dev.ts";
import { within } from "./watch.ts";

const CLI = join(import.meta.dir, "..", "..", "..", "apps", "host", "src", "cli.ts");

/** A real doriface-host with its own hc core, keeping an uplink to a local relay (wrangler dev). */
export interface RelayedHost {
  readonly relayUrl: string;
  readonly hostId: string;
  readonly hostKey: Uint8Array;
  readonly session: HcSession;
  readonly stateDir: string;
  readonly scratch: string;
  /** Sends the test's own client IP, so the relay's per-IP budgets are this test's alone. */
  readonly createSocket: CreateSocket;
  readonly logs: readonly string[];
  /** The source IP this host's sockets claim, for requests the relay rate-limits by IP. */
  readonly ip: string;
  pairingLink(): Promise<string>;
  /** A fresh offer as `doriface-host pair` prints it: the link and the typed code. */
  pairingOffer(): Promise<{ readonly url: string; readonly code: string }>;
  pairingCode(): Promise<string>;
  /** Revokes every paired device, as `doriface-host devices revoke` does: the running host closes their sessions. */
  revokeAll(): Promise<void>;
  /** Runs typed-code pairing (CPace on a `?pair=<slot>` session) and returns the confirmed session. */
  dialPairCode(device: KeyPair, code: string, name: string): Promise<SecureLink>;
  pair(device: KeyPair, name: string): Promise<void>;
  /** A session through the relay; `stream` names what it carries (the hc stream by default). */
  dial(device: KeyPair, stream?: "push"): Promise<SecureLink>;
  connect(device: KeyPair): Promise<HcConnection>;
  /** A connection whose plaintext is kept, to compare with what the host's hc read and wrote. */
  connectRecorded(device: KeyPair): Promise<{ readonly connection: HcConnection; readonly link: RecordingLink }>;
  /** What every `hc connect` the host ran read and wrote, recorded before it was passed on. */
  taps(): Tap[];
  stop(): Promise<void>;
}

export interface RelayedHostOptions {
  /** For tests of this helper: the relay the host dials, instead of the local one. */
  readonly hostRelayUrl?: string;
  readonly uplinkTimeoutMs?: number;
  /** Wraps the sockets the host's uplink and the clients open, e.g. to capture what the relay forwards. */
  readonly wrapSockets?: (base: CreateSocket) => { readonly host: CreateSocket; readonly client: CreateSocket };
  /** Origins of a test push service the host may post web push notices to. */
  readonly pushTestOrigins?: readonly string[];
  /** Where the scratch dir is made (the system tmp dir by default), so a test can check that its own is removed. */
  readonly scratchRoot?: string;
}

const UPLINK_TIMEOUT_MS = 30_000;

/** Starts the relay, the hc core and the host; any failure along the way stops whatever had started. */
export async function startRelayedHost(prefix: string, options: RelayedHostOptions = {}): Promise<RelayedHost> {
  const scratch = mkdtempSync(join(options.scratchRoot ?? tmpdir(), "rh-"));
  const stateDir = join(scratch, "host-state");
  const ip = testIp();
  const base = socketFrom(ip);
  const sockets = options.wrapSockets?.(base) ?? { host: base, client: base };
  const createSocket = sockets.client;
  const logs: string[] = [];
  const connected = Promise.withResolvers<void>();
  let relay: LocalRelay | undefined;
  let session: HcSession | undefined;
  let host: Host | undefined;
  const stop = async (): Promise<void> => {
    if (logs.length > 0) console.log(`host log:\n${logs.join("\n")}`);
    await host?.stop();
    await session?.dispose();
    await relay?.stop();
    rmSync(scratch, { recursive: true, force: true });
  };
  try {
    relay = await startLocalRelay();
    session = createHcSession(prefix);
    host = await startHost({
      listen: { hostname: "127.0.0.1", port: 0 },
      token: "relayed-host-token-relayed-host-token-relayed",
      hc: tappedHc(scratch, session.hc),
      session: session.name,
      env: session.env,
      stateDir,
      relay: { url: options.hostRelayUrl ?? relay.url, createSocket: sockets.host },
      pushTestOrigins: options.pushTestOrigins,
      log: (line) => {
        logs.push(line);
        if (line.startsWith("relay: connected")) connected.resolve();
      },
    });
    const uplinkMs = options.uplinkTimeoutMs ?? UPLINK_TIMEOUT_MS;
    await within(connected.promise, "the host's relay uplink", uplinkMs);
    const e2ee = host.e2ee;
    if (e2ee === undefined) throw new Error("the host has no E2EE endpoint");
    return await relayedHost({
      relayUrl: relay.url,
      hostId: e2ee.hostId,
      ip,
      session,
      stateDir,
      scratch,
      createSocket,
      logs,
      stop,
    });
  } catch (error) {
    await stop();
    throw error;
  }
}

interface Started {
  readonly relayUrl: string;
  readonly hostId: string;
  readonly ip: string;
  readonly session: HcSession;
  readonly stateDir: string;
  readonly scratch: string;
  readonly createSocket: CreateSocket;
  readonly logs: readonly string[];
  readonly stop: () => Promise<void>;
}

async function relayedHost(started: Started): Promise<RelayedHost> {
  const { relayUrl, hostId, stateDir, scratch, createSocket } = started;
  const pairingOffer = async (): Promise<{ readonly url: string; readonly code: string }> => {
    const args = ["pair", "--no-qr", "--web-origin", "https://web.example", "--relay", relayUrl];
    const proc = Bun.spawn([process.execPath, CLI, ...args, "--state-dir", stateDir], { stdout: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const url = stdout.split("\n").find((line) => line.startsWith("https://web.example/pair#"));
    const code = /^code\s+(\S{4}) (\S{4})/m.exec(stdout);
    if ((await proc.exited) !== 0 || url === undefined || code === null) throw new Error(`pair failed: ${stdout}`);
    return { url, code: `${code[1]}${code[2]}` };
  };
  const pairingLink = async (): Promise<string> => (await pairingOffer()).url;
  const hostKey = parsePairingUrl(await pairingLink()).noiseStaticPub;
  const open = async (device: KeyPair, pairing?: PairingSecret, stream?: "push"): Promise<SecureLink> => {
    const pairSlot = pairing?.mode === "code" ? pairSlotOf(pairing.code) : undefined;
    const link = await connectRelayClient({
      relayUrl,
      hostId,
      createSocket,
      ...(pairSlot === undefined ? {} : { pairSlot }),
    });
    return secureLink(link, {
      role: "initiator",
      hostId,
      staticKey: rawStaticKey(device),
      remoteStatic: hostKey,
      pairing,
      stream,
    });
  };
  return {
    ...started,
    hostKey,
    pairingLink,
    pairingOffer,
    pairingCode: async () => (await pairingOffer()).code,
    async revokeAll() {
      const devices = new DeviceStore(stateDir);
      for (const device of devices.list()) devices.revoke(deviceIdOf(device));
      await requestControl(stateDir, { op: "devices-changed" });
    },
    dialPairCode: (device, code, name) => open(device, { mode: "code", code, name }),
    async pair(device, name) {
      const { linkSecret } = parsePairingUrl(await pairingLink());
      // The host answers hello on a pairing session only once it stored the device.
      (await HcConnection.open(await open(device, { mode: "link", linkSecret, name }))).close();
    },
    dial: (device, stream) => open(device, undefined, stream),
    connect: async (device) => HcConnection.open(await open(device)),
    async connectRecorded(device) {
      const link = new RecordingLink(await open(device));
      return { connection: await HcConnection.open(link), link };
    },
    taps: () => taps(scratch),
  };
}
