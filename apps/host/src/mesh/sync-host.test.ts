import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { buildPairingUrl } from "@doriface/crypto";
import { hashOf } from "@doriface/mesh";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateToken } from "../auth.ts";
import { requestControl } from "../control.ts";
import { type Host, startHost } from "../host.ts";
import { loadHostIdentity } from "../state/host-keys.ts";
import { MeshStore } from "../state/mesh.ts";
import { pendingFromWire } from "../state/pairing.ts";
import { FakeRelay } from "../testing/fake-relay.ts";
import { createHcSession, type HcSession } from "../testing/hc-session.ts";
import { RelayClientBridge } from "../testing/relay-client-bridge.ts";

setDefaultTimeout(60_000);

interface Running {
  readonly name: string;
  readonly dir: string;
  readonly session: HcSession;
  readonly relay: FakeRelay;
  readonly bridge: RelayClientBridge;
  readonly host: Host;
  /** Resolves once `done` holds, checked on every line the host logs. */
  logsUntil(done: () => boolean): Promise<void>;
}

const running: Running[] = [];
afterAll(async () => {
  await Promise.all(running.map(({ host }) => host.stop()));
  await Promise.all(running.flatMap(({ bridge, relay, session }) => [bridge.stop(), relay.stop(), session.dispose()]));
  for (const { dir } of running.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The one relay all hosts share in production: here, each client dial reaches its target host's own fake relay. */
function routeClients(url: string): WebSocket {
  const parsed = new URL(url);
  const [, , kind, hostId] = parsed.pathname.split("/");
  const target = kind === "client" ? running.find((entry) => entry.host.e2ee?.hostId === hostId) : undefined;
  if (target === undefined) return new WebSocket(url);
  const bridge = new URL(target.bridge.url);
  return new WebSocket(`ws://${bridge.host}${parsed.pathname}${parsed.search}`);
}

async function start(name: string): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), `dh-sync-host-${name}-`));
  const session = createHcSession(`sync-${name}`);
  const relay = new FakeRelay();
  const bridge = new RelayClientBridge(relay);
  const waiters = new Set<() => void>();
  const host = await startHost({
    listen: { hostname: "127.0.0.1", port: 0 },
    token: generateToken(),
    hc: session.hc,
    session: session.name,
    env: session.env,
    stateDir: dir,
    relay: { url: relay.url, createSocket: routeClients },
    log: () => {
      for (const waiter of waiters) waiter();
    },
  });
  const logsUntil = (done: () => boolean): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const check = (): void => {
      if (!done()) return;
      waiters.delete(check);
      resolve();
    };
    waiters.add(check);
    check();
    return promise;
  };
  const started = { name, dir, session, relay, bridge, host, logsUntil };
  running.push(started);
  await relay.answers.next();
  return started;
}

async function joinVia(joiner: Running, inviter: Running): Promise<void> {
  const offer = pendingFromWire(await requestControl(inviter.dir, { op: "mesh-pair", auto: true }));
  const identity = loadHostIdentity(inviter.dir);
  const link = buildPairingUrl({
    webOrigin: "https://doriface.example",
    hostId: identity.hostId,
    noiseStaticPub: identity.noise.publicKey,
    signPub: identity.sign.publicKey,
    linkSecret: offer.linkSecret,
    relayUrl: inviter.bridge.url,
    mesh: true,
  });
  await requestControl(joiner.dir, {
    op: "mesh-join",
    target: link,
    fingerprint: undefined,
    name: undefined,
    relay: undefined,
    yes: true,
  });
}

const setAt = (entry: Running): string =>
  (new MeshStore(entry.dir, { log: () => {} }).read()?.records ?? []).map(hashOf).toSorted().join(",");

describe("sync runs in the running host (sections 5.1 and 5.3)", () => {
  test("a joins nobody, b joins a, c joins b: a learns of c by sync alone, and every host ends with the same set", async () => {
    const [a, b, c] = [await start("alpha"), await start("beta"), await start("gamma")];
    await joinVia(b, a);
    await joinVia(c, b);
    const converged = (): boolean => new Set([a, b, c].map(setAt)).size === 1 && setAt(a).split(",").length > 3;
    await Promise.any([a, b, c].map((entry) => entry.logsUntil(converged)));
    expect(converged()).toBe(true);
    const view = new MeshStore(a.dir, { log: () => {} }).authorizeIndex();
    expect(view?.member(Buffer.from(loadHostIdentity(c.dir).noise.publicKey).toString("base64url"))).toBeDefined();
  });
});
