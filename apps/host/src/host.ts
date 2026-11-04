import packageJson from "../package.json" with { type: "json" };
import { fingerprintOf, type HostIdentity } from "@doriface/crypto";
import type { MeshStatus } from "@doriface/protocol";
import type { CreateSocket, RelayProofs } from "@doriface/relay-client";
import { controlIsLive, listenControl } from "./control.ts";
import { lanUrlsFor } from "./lan-urls.ts";
import { LiveSessions } from "./e2ee/sessions.ts";
import { endSweeper } from "./end-sweeper.ts";
import { createGateway } from "./gateway.ts";
import { HcPipe, readHcVersion } from "./hc-pipe.ts";
import { listenError, StartupError } from "./startup-error.ts";
import { assertListenAllowed, formatHost, type ListenAddress } from "./listen.ts";
import { type PairingSlotRegistrar, PairingSlots } from "./pairing-slots.ts";
import { HostUplink } from "./relay/host-uplink.ts";
import { openRelayPasses } from "./relay/relay-passes.ts";
import { RelaySessionWire } from "./relay/session-wire.ts";
import { DeviceStore } from "./state/devices.ts";
import { loadHostIdentity } from "./state/host-keys.ts";
import { MeshStore } from "./state/mesh.ts";
import type { MeshHooks } from "./mesh/host-hooks.ts";
import { meshDeps } from "./mesh/host-deps.ts";
import { PairingStore, pendingToWire } from "./state/pairing.ts";

export const HOST_VERSION = packageJson.version;

export interface HostOptions {
  readonly listen: ListenAddress;
  readonly token: string;
  readonly hc: string;
  readonly session?: string | undefined;
  /** Environment for the `hc connect` children; defaults to this process's. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Allow a non-loopback bind. The endpoint is plaintext, so this exposes the token and the shell. */
  readonly unsafeListen?: boolean | undefined;
  /** Where the host keys, paired devices and pending pairing live; enables `/v1/e2ee`. */
  readonly stateDir?: string | undefined;
  /** A second listener serving only healthz and `/v1/e2ee`; it may bind any address. */
  readonly lanListen?: ListenAddress | undefined;
  /** For tests: messages per direction between rekeys. */
  readonly rekeyInterval?: number | undefined;
  /** For tests: the direct-path idle close (default 90 s). */
  readonly directIdleMs?: number | undefined;
  /** Registers typed-code pairing slots; defaults to the relay uplink when there is one. */
  readonly pairingSlots?: PairingSlotRegistrar | undefined;
  /** Keeps an authenticated uplink to this relay and answers E2EE sessions through it; needs `stateDir`. */
  readonly relay?: { readonly url: string; readonly createSocket?: CreateSocket | undefined } | undefined;
  /** The mesh status `mesh status` asks for; undefined while this host is in no mesh. Defaults to mesh.json's. */
  readonly meshStatus?: (() => MeshStatus | undefined) | undefined;
  /** For tests: the program mesh lines' `via` names; defaults to this executable or a launcher of this entry point. */
  readonly meshProgram?: string | undefined;
  /** The running mesh parts the mesh commands and status reach; defaults to this host's own sync (`syncHooks`). */
  readonly meshHooks?: MeshHooks | undefined;
  readonly log: (line: string) => void;
}

export interface E2eeEndpoint {
  readonly hostId: string;
  readonly fingerprint: string;
  /** `/v1/e2ee` on the main listener. */
  readonly url: string;
  /** The dialable `/v1/e2ee` URLs of the LAN listener (IP literals, also sent in message 2); empty without one. */
  readonly lanUrls: readonly string[];
}

export interface Host {
  /** The WebSocket endpoint, e.g. `ws://127.0.0.1:7766/v1/hc`. */
  readonly url: string;
  readonly port: number;
  readonly hcVersion: string;
  readonly e2ee: E2eeEndpoint | undefined;
  /** The relay this host keeps its uplink to, when it does. */
  readonly relayUrl: string | undefined;
  /** Closes every client and `hc connect` child, then the listener. */
  stop(): Promise<void>;
}

export async function startHost(options: HostOptions): Promise<Host> {
  const { hostname, port } = options.listen;
  assertListenAllowed(options.listen, options.unsafeListen === true);
  if (options.lanListen !== undefined && options.stateDir === undefined) {
    throw new Error("a LAN listener serves only /v1/e2ee, which needs a state dir");
  }
  if (options.stateDir !== undefined && (await controlIsLive(options.stateDir))) {
    const message = `another doriface-host is already running on ${options.stateDir}`;
    throw new StartupError("already-running", message, { path: options.stateDir });
  }
  const hcVersion = await readHcVersion(options.hc);
  const stateDir = options.stateDir;
  if (options.relay !== undefined && stateDir === undefined) throw new Error("the relay uplink needs a state dir");
  const identity = stateDir === undefined ? undefined : loadHostIdentity(stateDir);
  const proofs =
    options.relay === undefined || stateDir === undefined || identity === undefined
      ? undefined
      : await openRelayPasses(stateDir, identity, options.log);
  const uplink =
    options.relay === undefined || identity === undefined
      ? undefined
      : new HostUplink({
          relayUrl: options.relay.url,
          createSocket: options.relay.createSocket,
          proofs,
          identity,
          log: options.log,
        });
  const e2ee =
    stateDir === undefined || identity === undefined
      ? undefined
      : e2eeDeps(stateDir, identity, options.pairingSlots ?? uplink, options, proofs);
  const ends = endSweeper({ hc: options.hc, session: options.session, env: options.env }, options.log);
  const gateway = createGateway({
    e2ee,
    token: options.token,
    hostVersion: HOST_VERSION,
    hcVersion,
    log: options.log,
    directIdleMs: options.directIdleMs,
    openPipe: () => {
      void ends.ensure();
      return new HcPipe({ hc: options.hc, session: options.session, env: options.env, log: options.log });
    },
  });
  await uplink?.start({
    onSession: (session) => {
      gateway
        .serveE2ee(new RelaySessionWire(session), { kind: "relay", openSlot: session.pairSlot })
        .catch((error: unknown) => {
          options.log(`relay session ${session.sessionId} failed: ${String(error)}`);
          session.close(1011, "internal error");
        });
    },
    onConnected: () => {
      e2ee?.slots.relayConnected();
      e2ee?.sync.uplinkAnswered();
    },
    onDropped: () => e2ee?.sync.uplinkDropped(),
    onFinalClose: () => e2ee?.slots.relayGone(),
  });
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({ hostname, port, fetch: gateway.app.fetch, websocket: gateway.websocket });
  } catch (error) {
    await uplink?.stop();
    throw listenError(error, `${formatHost(hostname)}:${port}`);
  }
  const lan = options.lanListen;
  let lanServer: ReturnType<typeof Bun.serve> | undefined;
  try {
    lanServer =
      lan === undefined || e2ee === undefined
        ? undefined
        : Bun.serve({
            hostname: lan.hostname,
            port: lan.port,
            fetch: gateway.lanApp.fetch,
            websocket: gateway.websocket,
          });
  } catch (error) {
    await uplink?.stop();
    await server.stop(true);
    throw lan === undefined ? error : listenError(error, `${formatHost(lan.hostname)}:${lan.port}`);
  }
  if (lan !== undefined && lanServer !== undefined) {
    e2ee?.lanUrls.push(...lanUrlsFor(lan.hostname, lanServer.port ?? lan.port));
  }
  let control: ReturnType<typeof openControl> | undefined;
  try {
    control =
      options.stateDir === undefined || e2ee === undefined
        ? undefined
        : openControl(options.stateDir, e2ee, options.meshStatus ?? e2ee.meshStatus);
  } catch (error) {
    await Promise.all([server.stop(true), lanServer?.stop(true)]);
    throw new Error(`cannot open the control socket that devices revoke uses: ${String(error)}`, { cause: error });
  }
  e2ee?.slots.start();
  const boundPort = server.port ?? port;
  const base = `ws://${formatHost(hostname)}:${boundPort}`;
  let stopping: Promise<void> | undefined;
  return {
    url: `${base}/v1/hc`,
    port: boundPort,
    hcVersion,
    e2ee:
      e2ee === undefined
        ? undefined
        : {
            hostId: e2ee.identity.hostId,
            fingerprint: fingerprintOf(e2ee.identity.noise.publicKey),
            url: `${base}/v1/e2ee`,
            lanUrls: e2ee.lanUrls,
          },
    relayUrl: uplink === undefined ? undefined : options.relay?.url,
    stop() {
      e2ee?.slots.stop();
      control?.stop();
      stopping ??= Promise.resolve(e2ee?.sync.stop())
        .then(() => uplink?.stop())
        .then(() => gateway.closeAll())
        .then(() => ends.stop())
        .then(() => Promise.all([server.stop(true), lanServer?.stop(true)]))
        .then(() => undefined);
      return stopping;
    },
  };
}

/** The control socket is how `devices revoke` closes live sessions, so a host that cannot open it does not start. */
function openControl(
  stateDir: string,
  e2ee: ReturnType<typeof e2eeDeps>,
  meshStatus: (() => MeshStatus | undefined) | undefined,
) {
  return listenControl(stateDir, async (request, closed) => {
    switch (request.op) {
      case "devices-changed":
        return e2ee.sessions.closeRevoked();
      case "mesh-changed":
        e2ee.sync.changed();
        return e2ee.sessions.closeRevoked();
      case "pair":
        return pendingToWire(await e2ee.hostMesh.pairDevice());
      case "mesh-pair":
        return pendingToWire(await e2ee.hostMesh.pair(request.auto));
      case "mesh-pending":
        return e2ee.hostMesh.pending.next(closed);
      case "mesh-approve":
        return { decided: e2ee.hostMesh.pending.decide(request.nonce, request.approve) };
      case "mesh-join":
        return e2ee.hostMesh.join(request);
      case "mesh-status":
        return meshStatus?.() ?? null;
      case "mesh-revoke":
        return e2ee.meshCommands.revoke(request);
      case "mesh-rename":
        return e2ee.meshCommands.rename(request);
      case "mesh-leave":
        return e2ee.meshCommands.leave();
    }
  });
}

function e2eeDeps(
  stateDir: string,
  identity: HostIdentity,
  registrar: PairingSlotRegistrar | undefined,
  options: HostOptions,
  proofs: RelayProofs | undefined,
) {
  const devices = new DeviceStore(stateDir);
  const pairing = new PairingStore(stateDir, options.log);
  const mesh = new MeshStore(stateDir, { log: options.log });
  mesh.ensureIndex();
  /** Filled in once the LAN listener has its port. */
  const lanUrls: string[] = [];
  const slots = new PairingSlots(pairing, identity.noise.publicKey, registrar, options.log);
  const sessions = new LiveSessions(devices, options.log, mesh);
  const meshParts = meshDeps({
    stateDir,
    identity,
    mesh,
    slots,
    sessions,
    hc: { hc: options.hc, session: options.session, env: options.env },
    relay: { url: options.relay?.url, createSocket: options.relay?.createSocket, proofs },
    program: options.meshProgram,
    hooks: options.meshHooks,
    log: options.log,
  });
  return {
    identity,
    lanUrls,
    devices,
    pairing,
    mesh,
    slots,
    sessions,
    ...meshParts,
    rekeyInterval: options.rekeyInterval,
    log: options.log,
  };
}
