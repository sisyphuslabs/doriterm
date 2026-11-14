import { DEFAULT_RELAY_URL, fingerprintOf } from "@doriface/crypto";
import { controlIsLive } from "./control.ts";
import { lanUrlsFor } from "./lan-urls.ts";
import { endSweeper } from "./end-sweeper.ts";
import { createGateway } from "./gateway.ts";
import { HC_VERSION_FLOOR, meetsHcFloor } from "./hc-install.ts";
import { watchRevocations } from "./e2ee/revocation-watch.ts";
import { SpeculativeHello } from "./e2ee/speculative-hello.ts";
import { HcPipe, readHcVersion } from "./hc-pipe.ts";
import { openControl } from "./host-control.ts";
import { e2eeDeps } from "./host-e2ee.ts";
import { PairOffers } from "./pair-surface.ts";
import { DeviceSurface } from "./device-surface.ts";
import { type GitFactsPublisher, publishGitFacts } from "./git-facts.ts";
import { type HostInfoPublisher, publishHostInfo } from "./host-info.ts";
import { type MeshOfferService, serveMeshOffers } from "./mesh/offer-doc.ts";
import { pairingArtifact } from "./pair-link.ts";
import { retireLock } from "./host-lock.ts";
import { publishMeshStatusOnCore, type MeshStatusPublisher } from "./mesh/status-publisher.ts";
import { type Host, HOST_VERSION, type HostOptions } from "./host-types.ts";
import { listenError, StartupError } from "./startup-error.ts";
import { type StartedPart, stopStarted } from "./stop-started.ts";
import { assertListenAllowed, formatHost } from "./listen.ts";
import { HostUplink } from "./relay/host-uplink.ts";
import { openRelayPasses } from "./relay/relay-passes.ts";
import { RelaySessionWire } from "./relay/session-wire.ts";
import { loadHostIdentity } from "./state/host-keys.ts";
import { startHostPush } from "./push/host-push.ts";

export { HOST_VERSION, type E2eeEndpoint, type Host, type HostOptions } from "./host-types.ts";

export async function startHost(options: HostOptions): Promise<Host> {
  assertListenAllowed(options.listen, options.unsafeListen === true);
  if (options.lanListen !== undefined && options.stateDir === undefined) {
    throw new Error("a LAN listener serves only /v1/e2ee, which needs a state dir");
  }
  if (options.stateDir !== undefined && (await controlIsLive(options.stateDir))) {
    const message = `another doriface-host is already running on ${options.stateDir}`;
    throw new StartupError("already-running", message, { path: options.stateDir });
  }
  const hcVersion = await readHcVersion(options.hc);
  if (!meetsHcFloor(hcVersion)) {
    const message = `${options.hc} is herdr-core ${hcVersion}; doriface-host needs ${HC_VERSION_FLOOR} or newer`;
    throw new StartupError("hc-version-failed", message, { path: options.hc, version: hcVersion });
  }
  // A start that fails stops what it had started, latest first, so it leaves no hc connect child, listener or socket.
  const parts: StartedPart[] = [];
  try {
    return await serve(options, hcVersion, (name, stop, kill) =>
      parts.push(kill === undefined ? { name, stop } : { name, stop, kill }),
    );
  } catch (error) {
    await stopStarted(parts, options.log);
    throw error;
  }
}

/** Starts every part of the host; `started` records how to stop each one once it runs. */
async function serve(
  options: HostOptions,
  hcVersion: string,
  started: (name: string, stop: () => unknown, kill?: () => readonly string[]) => void,
): Promise<Host> {
  const { hostname, port } = options.listen;
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
  if (e2ee !== undefined) started("mesh sync", () => e2ee.sync.stop());
  if (e2ee !== undefined && stateDir !== undefined)
    started(
      "revocation watch",
      watchRevocations(stateDir, () => e2ee.sessions.closeRevoked(), options.log),
    );
  const push =
    stateDir === undefined || e2ee === undefined
      ? undefined
      : await startHostPush({
          stateDir,
          hostId: e2ee.identity.hostId,
          devices: e2ee.devices,
          mesh: e2ee.mesh,
          hc: {
            hc: options.hc,
            session: options.session,
            env: options.env,
            handshakeTimeoutMs: options.hcHandshakeTimeoutMs,
          },
          extraOrigins: options.pushTestOrigins,
          log: options.log,
        });
  if (push !== undefined) {
    started(
      "push feed",
      () => push.stop(),
      () => push.kill().map((pid) => `hc connect pid ${pid}`),
    );
  }
  // What every `hc connect` the host's own writers start reaches, and how long its hello may go unanswered.
  const core = {
    hc: options.hc,
    session: options.session,
    env: options.env,
    handshakeTimeoutMs: options.hcHandshakeTimeoutMs,
  };
  const ends = endSweeper(core, options.log);
  started(
    "end sweeper",
    () => ends.stop(),
    () => ends.kill().map((pid) => `hc connect pid ${pid}`),
  );
  // The host's OS goes on its core once a client opens a pipe, as the end sweeper starts: every hc call starts its
  // session's core when none runs, and a host that no one uses must not start one (#306).
  // One expression for the status: the publisher and the control channel must answer from the same function (review #761).
  const meshStatus = options.meshStatus ?? e2ee?.meshStatus;
  // Both read herdr's machine list again first, bounded, so a line herdr connected since the last reconcile reads so (#754).
  const refreshMeshLines = (): Promise<void> => e2ee?.refreshMeshLines() ?? Promise.resolve();
  let info: HostInfoPublisher | undefined;
  let git: GitFactsPublisher | undefined;
  let meshDoc: MeshStatusPublisher | undefined;
  let offers: MeshOfferService | undefined;
  // A one-line Add a machine (#668): a client asks for a mesh offer through a core document, and the host answers it.
  const meshOffer = async (client: boolean) => {
    if (e2ee === undefined) throw new Error("this host keeps no state, so it cannot open a mesh offer");
    const offer = await e2ee.hostMesh.pair(!client);
    const keys = e2ee.identity;
    const link = pairingArtifact(
      {
        hostId: keys.hostId,
        noiseStaticPub: keys.noise.publicKey,
        signPub: keys.sign.publicKey,
        linkSecret: offer.linkSecret,
        relayUrl: options.relay?.url ?? DEFAULT_RELAY_URL,
        mesh: true,
      },
      undefined,
    ).url;
    return { link, expiresAt: offer.expiresAt };
  };
  started(
    "mesh offers",
    () => offers?.stop(),
    () => (offers?.kill() ?? []).map((pid) => `hc connect pid ${pid}`),
  );
  started(
    "host info",
    () => info?.stop(),
    () => (info?.kill() ?? []).map((pid) => `hc connect pid ${pid}`),
  );
  // An early hello is answered only once a client has been admitted and the host's own services run (#1271): before
  // that, an `hc connect` could start the session's core, and nothing a replayed message 1 reaches may start anything.
  const speculative = new SpeculativeHello({
    spawn: () =>
      info === undefined
        ? undefined
        : new HcPipe({ hc: options.hc, session: options.session, env: options.env, log: options.log }),
  });
  started("speculative hello", () => speculative.stop());
  const gateway = createGateway({
    e2ee,
    speculative,
    push: push?.serve,
    pair:
      e2ee === undefined
        ? undefined
        : new PairOffers({
            identity: e2ee.identity,
            pairing: e2ee.pairing,
            devices: e2ee.devices,
            open: () => e2ee.hostMesh.pairDevice(),
            relayUrl: options.relay?.url ?? DEFAULT_RELAY_URL,
          }),
    // A revoke from the app is the same act as `devices revoke` on the control socket: the file loses the device, the
    // sessions of its key close, and its push subscription goes.
    devices:
      e2ee === undefined
        ? undefined
        : new DeviceSurface({
            devices: e2ee.devices,
            changed: async () => {
              e2ee.hostMesh.sweepRoster();
              await e2ee.sessions.closeRevoked();
              push?.prune();
            },
          }),
    token: options.token,
    hostVersion: HOST_VERSION,
    hcVersion,
    log: options.log,
    directIdleMs: options.directIdleMs,
    resumeGraceMs: options.resumeGraceMs,
    openPipe: () => {
      void ends.ensure();
      info ??= publishHostInfo(core, options.platform ?? process.platform, options.log);
      git ??= publishGitFacts(core, options.log);
      meshDoc ??=
        meshStatus === undefined || e2ee === undefined
          ? undefined
          : publishMeshStatusOnCore(
              core,
              meshStatus,
              e2ee.identity.hostId,
              options.log,
              undefined,
              undefined,
              refreshMeshLines,
            );
      if (e2ee !== undefined) {
        const pending = e2ee.hostMesh.pending;
        offers ??= serveMeshOffers(
          core,
          options.log,
          (listener) => pending.onAdmitted(listener),
          meshOffer,
          undefined,
          undefined,
          (nonce, approve, code) => pending.decide(nonce, approve, code),
        );
      }
      return new HcPipe({ hc: options.hc, session: options.session, env: options.env, log: options.log });
    },
  });
  started("gateway", () => gateway.closeAll());
  started(
    "git facts",
    () => git?.stop(),
    () => (git?.kill() ?? []).map((pid) => `hc connect pid ${pid}`),
  );
  // A host in no mesh writes the document empty (a mesh it left), so this starts with the first pipe, as the others do.
  started(
    "mesh status",
    () => meshDoc?.stop(),
    () => (meshDoc?.kill() ?? []).map((pid) => `hc connect pid ${pid}`),
  );
  if (uplink !== undefined) started("relay uplink", () => uplink.stop());
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
    throw listenError(error, `${formatHost(hostname)}:${port}`);
  }
  started("main listener", () => server.stop(true));
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
    throw lan === undefined ? error : listenError(error, `${formatHost(lan.hostname)}:${lan.port}`);
  }
  if (lanServer !== undefined) started("LAN listener", () => lanServer.stop(true));
  if (lan !== undefined && lanServer !== undefined) {
    e2ee?.lanUrls.push(...lanUrlsFor(lan.hostname, lanServer.port ?? lan.port));
  }
  let control: ReturnType<typeof openControl> | undefined;
  try {
    control =
      options.stateDir === undefined || e2ee === undefined
        ? undefined
        : openControl(
            options.stateDir,
            e2ee,
            meshStatus === undefined
              ? undefined
              : async () => {
                  await refreshMeshLines();
                  return meshStatus();
                },
            push,
          );
  } catch (error) {
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
    hostInfoSettled: () => info?.settled ?? Promise.resolve(),
    gitFactsSettled: () => git?.settled() ?? Promise.resolve(),
    meshStatusSettled: () => meshDoc?.settled() ?? Promise.resolve(),
    stop() {
      const pushStopped = push?.stop();
      e2ee?.slots.stop();
      control?.stop();
      stopping ??= Promise.resolve(meshDoc?.stop())
        .then(() => e2ee?.sync.stop())
        .then(() => uplink?.stop())
        .then(() => gateway.closeAll())
        .then(() => ends.stop())
        .then(() => Promise.all([info?.stop(), git?.stop(), offers?.stop()]))
        .then(() => pushStopped)
        .then(() => Promise.all([server.stop(true), lanServer?.stop(true)]))
        .then(() => retireLock(stateDir, options.log));
      return stopping;
    },
  };
}
