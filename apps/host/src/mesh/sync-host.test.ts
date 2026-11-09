import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { buildPairingUrl } from "@doriface/crypto";
import { hashOf } from "@doriface/mesh";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { ownMeshSession } from "../testing/mesh-session.ts";
import { RUN_MARK, runProcesses } from "../testing/run-cores.ts";
import { RelayClientBridge } from "../testing/relay-client-bridge.ts";
import { DIAL_LIMITS } from "./dial-policy.ts";
import { openHcControl } from "./hc-machines.ts";
import { meshHostOf, shellQuote } from "./via.ts";

const CLI = join(import.meta.dir, "..", "cli.ts");

setDefaultTimeout(60_000);

interface Running {
  readonly name: string;
  readonly dir: string;
  readonly program: string;
  readonly session: HcSession;
  readonly relay: FakeRelay;
  readonly bridge: RelayClientBridge;
  readonly host: Host;
  readonly logged: readonly string[];
  /** Resolves once `done` holds, checked on every line the host logs. */
  logsUntil(done: () => boolean): Promise<void>;
}

const running: Running[] = [];
afterAll(async () => {
  await Promise.all(running.map(({ bridge }) => bridge.stop()));
  await Promise.all(running.map(({ host }) => host.stop()));
  await Promise.all(running.flatMap(({ relay, session }) => [relay.stop(), session.dispose()]));
  const found = await runProcesses({ mark: process.env[RUN_MARK] ?? "", dir: tmpdir() });
  const left = found.filter((child) => running.some(({ dir }) => child.command.includes(dir)));
  console.log(`MESH_SYNC_LEFTOVERS=${left.length} pids=${left.map((child) => child.pid).join(",")}`);
  for (const { dir } of running.splice(0)) rmSync(dir, { recursive: true, force: true });
  expect(left.map((child) => child.pid)).toEqual([]);
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
  const session = await ownMeshSession(createHcSession(`sync-${name}`));
  const relay = new FakeRelay();
  const bridge = new RelayClientBridge(relay);
  const waiters = new Set<() => void>();
  const logged: string[] = [];
  const program = join(dir, "doriface-host");
  writeFileSync(program, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(CLI)} "$@"\n`);
  chmodSync(program, 0o700);
  const host = await startHost({
    meshProgram: program,
    listen: { hostname: "127.0.0.1", port: 0 },
    token: generateToken(),
    hc: session.hc,
    session: session.name,
    env: session.env,
    stateDir: dir,
    relay: { url: relay.url, createSocket: routeClients },
    log: (line) => {
      logged.push(line);
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
  const started = { name, dir, program, session, relay, bridge, host, logged, logsUntil };
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

const machinesOf = async (entry: Running): Promise<readonly string[]> => {
  const control = await openHcControl({
    hc: entry.session.hc,
    session: entry.session.name,
    env: entry.session.env,
  });
  try {
    const listed = await control.machines.list();
    return listed
      .filter((m) => meshHostOf(m.target, entry.program, entry.dir) !== undefined)
      .map((m) => meshHostOf(m.target, entry.program, entry.dir) ?? "")
      .toSorted();
  } finally {
    await control.stop();
  }
};

const added = (entry: Running): number => entry.logged.filter((line) => line.startsWith("mesh: added machine")).length;

/**
 * Design section 8.2 (#106, M-E3): a newcomer joining N - 1 members starts exactly 3N - 3 charged relay upgrades (its
 * pairing dial, N - 2 ack pushes, and the two upgrades of each of the N - 1 machines it adds, reserved together), so
 * `machine.list` on every online member reflects the join within ceil((3N - 3) / 12) windows of the budget: one window
 * at 5 members, checked here with real herdr. join-bound.test.ts checks 6, 7 and 12 on a fake clock.
 */
const joinBoundMs = (members: number): number =>
  Math.ceil((3 * members - 3) / DIAL_LIMITS.budget) * DIAL_LIMITS.windowMs;

describe("sync runs in the running host (sections 5.1 and 5.3)", () => {
  test("b joins a, c joins b: all three converge by sync alone, and every core lists the other two as mesh machines", async () => {
    const [a, b, c] = [await start("alpha"), await start("beta"), await start("gamma")];
    await joinVia(b, a);
    await joinVia(c, b);
    const converged = (): boolean => new Set([a, b, c].map(setAt)).size === 1 && setAt(a).split(",").length > 3;
    await Promise.any([a, b, c].map((entry) => entry.logsUntil(converged)));
    expect(converged()).toBe(true);
    const view = new MeshStore(a.dir, { log: () => {} }).authorizeIndex();
    expect(view?.member(Buffer.from(loadHostIdentity(c.dir).noise.publicKey).toString("base64url"))).toBeDefined();

    const others = (entry: Running): readonly string[] =>
      [a, b, c]
        .filter((other) => other !== entry)
        .map((other) => other.host.e2ee?.hostId ?? "")
        .toSorted();
    await Promise.all([a, b, c].map((entry) => entry.logsUntil(() => added(entry) >= 2)));
    const listed = await Promise.all([a, b, c].map(async (entry) => [await machinesOf(entry), others(entry)]));
    for (const [got, want] of listed) expect(got).toEqual(want);
  });

  test("a fifth member joining a converged four adds every machine on every core within the 60 s bound (8.2, H-D1)", async () => {
    const hosts = await Promise.all(["one", "two", "three", "four"].map((name) => start(name)));
    const [first, ...rest] = hosts;
    if (first === undefined) throw new Error("no first host");
    await rest.reduce((joins, entry) => joins.then(() => joinVia(entry, first)), Promise.resolve());
    await Promise.all(hosts.map((entry) => entry.logsUntil(() => added(entry) >= 3)));
    const fifth = await start("five");
    const all = [...hosts, fifth];
    const joined = performance.now();
    await joinVia(fifth, first);
    const everyone = Promise.all(all.map((entry) => entry.logsUntil(() => added(entry) >= 4)));
    expect(joinBoundMs(all.length)).toBe(60_000);
    const bound = new Promise<"late">((resolve) => setTimeout(() => resolve("late"), joinBoundMs(all.length)));
    expect(await Promise.race([everyone.then(() => "in time" as const), bound])).toBe("in time");
    console.log(
      `five-host join: every core added every member ${Math.round(performance.now() - joined)} ms after the join`,
    );
  }, 300_000);
});
