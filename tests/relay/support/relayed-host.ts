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
import { connectRelayClient, type CreateSocket, PAIR_SLOT_REPLY_TIMEOUT_MS, pairSlotOf } from "@doriface/relay-client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestControl } from "../../../apps/host/src/control.ts";
import { createHcSession, type HcSession, stopLeftoverCores } from "../../../apps/host/src/testing/hc-session.ts";
import { RecordingLink, type Tap, taps, tappedHc } from "./byte-tap.ts";
import { onInterrupt } from "./process-group.ts";
import { socketFrom, testIp } from "./probe.ts";
import { type LocalRelay, RELAY_STOP_MS, startLocalRelay } from "./relay-dev.ts";

/**
 * The host's stop: it releases its pairing slot and waits for the relay's reply (PAIR_SLOT_REPLY_TIMEOUT_MS) before
 * closing its uplink, so a relay that does not answer holds it that long (measured 10.02 s against a stopped relay). With
 * an answering relay it took at most 0.66 s under induced load (~158, 20 stops); 2 s covers that part.
 */
export const HOST_STOP_MS = PAIR_SLOT_REPLY_TIMEOUT_MS + 2_000;
/** The hc core's stop, which has no escalation of its own: at most 0.49 s in the same 20 stops. */
export const CORE_STOP_MS = 2_000;
/**
 * A relayed host's whole stop: the host, its core and its relay in turn (the relay bounded by its own SIGKILL path,
 * RELAY_STOP_MS; measured at most 8.1 s), then 1 s for the scratch (at most 50 ms). Measured in total at most 8.4 s with
 * an answering relay; a relay that answers nothing costs the host's slot release and the relay's SIGKILL path in full.
 */
export const RELAYED_STOP_MS = HOST_STOP_MS + CORE_STOP_MS + RELAY_STOP_MS + 1_000;
import { rethrowAfter, settleAll } from "./settle.ts";
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
  /** Each line the host logs, as it logs it: e.g. "relay: connected ..." once its uplink is answered again. */
  readonly onLog?: (line: string) => void;
  /** For tests of this helper: told each part as it starts, so a test can check that a failed start stopped them all. */
  readonly started?: (
    part: { readonly relay: LocalRelay } | { readonly session: HcSession } | { readonly host: Host },
  ) => unknown;
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
  // Every step runs, whatever an earlier one threw: a host that fails to stop still has its core and relay stopped.
  const teardown = [
    () => host?.stop(),
    () => session?.dispose(),
    // The core runs outside every process group of this test (hc starts it as a daemon, or launchd does on macOS), so
    // the relay's leftover check never sees it; whether its socket still serves does, on every platform.
    async () => {
      const left = session === undefined ? [] : await stopLeftoverCores([session]);
      if (left.length > 0)
        throw new Error(`hc core outlived the relayed host's stop (now stopped): ${left.join(", ")}`);
    },
    () => relay?.stop(),
    () => rmSync(scratch, { recursive: true, force: true }),
  ];
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> =>
    (stopping ??= (async () => {
      unhook();
      if (logs.length > 0) console.log(`host log:\n${logs.join("\n")}`);
      const failures = await settleAll(teardown);
      if (failures.length > 0) throw new AggregateError(failures, "the relayed host did not stop cleanly");
    })());
  // A process that ends on SIGTERM or SIGINT (an e2e helper such as web-relay-host.ts is stopped with SIGTERM) runs
  // this stop to its end first. Otherwise the relay's group hook (adoptProcessGroup) kills the relay and raises the
  // signal again within a few milliseconds, ending the process before its host's stop has told the hc core to stop:
  // the core runs outside every process group of this process and outlives it (#2061). An interrupt during start-up
  // waits for the step in flight, which then ends start-up and tears down once, so no part starts after the teardown
  // has passed it (#2080).
  let interrupted = false;
  const settled = Promise.withResolvers<boolean>();
  const unhook = onInterrupt(async () => {
    interrupted = true;
    if (await settled.promise) await stop();
  });
  const unlessInterrupted = (): void => {
    if (interrupted) throw new Error("start-up was interrupted by SIGTERM or SIGINT");
  };
  try {
    relay = await startLocalRelay();
    unlessInterrupted();
    await options.started?.({ relay });
    unlessInterrupted();
    session = createHcSession(prefix);
    await options.started?.({ session });
    unlessInterrupted();
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
        options.onLog?.(line);
        if (line.startsWith("relay: connected")) connected.resolve();
      },
    });
    unlessInterrupted();
    await options.started?.({ host });
    unlessInterrupted();
    const uplinkMs = options.uplinkTimeoutMs ?? UPLINK_TIMEOUT_MS;
    await within(connected.promise, "the host's relay uplink", uplinkMs);
    const e2ee = host.e2ee;
    if (e2ee === undefined) throw new Error("the host has no E2EE endpoint");
    const started = await relayedHost({
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
    unlessInterrupted();
    settled.resolve(true);
    return started;
  } catch (error) {
    unhook();
    if (logs.length > 0) console.log(`host log:\n${logs.join("\n")}`);
    try {
      return await rethrowAfter(error, teardown);
    } finally {
      settled.resolve(false);
    }
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
