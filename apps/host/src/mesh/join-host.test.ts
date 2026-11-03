import { buildPairingUrl } from "@doriface/crypto";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateToken } from "../auth.ts";
import { requestControl } from "../control.ts";
import { type Host, startHost } from "../host.ts";
import { parseRecord } from "@doriface/mesh";
import { loadHostIdentity } from "../state/host-keys.ts";
import { MeshStore } from "../state/mesh.ts";
import { pendingFromWire } from "../state/pairing.ts";
import { FakeRelay } from "../testing/fake-relay.ts";
import { createHcSession, type HcSession } from "../testing/hc-session.ts";
import { RelayClientBridge } from "../testing/relay-client-bridge.ts";

setDefaultTimeout(60_000);

interface Running {
  readonly dir: string;
  readonly session: HcSession;
  readonly host: Host;
  readonly logs: string[];
  /** Resolves on the first log line from now on that matches `pattern`. */
  logged(pattern: RegExp): Promise<string>;
}

let relay: FakeRelay;
let bridge: RelayClientBridge;
const running: Running[] = [];

async function start(name: string, withRelay: boolean): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), `dh-join-host-${name}-`));
  const session = createHcSession(`mesh-${name}`);
  const logs: string[] = [];
  const waiters = new Set<(line: string) => void>();
  const logged = (pattern: RegExp): Promise<string> => {
    const { promise, resolve } = Promise.withResolvers<string>();
    const check = (line: string): void => {
      if (!pattern.test(line)) return;
      waiters.delete(check);
      resolve(line);
    };
    waiters.add(check);
    return promise;
  };
  const host = await startHost({
    listen: { hostname: "127.0.0.1", port: 0 },
    token: generateToken(),
    hc: session.hc,
    session: session.name,
    env: session.env,
    stateDir: dir,
    ...(withRelay ? { relay: { url: relay.url } } : {}),
    log: (line) => {
      logs.push(line);
      for (const waiter of waiters) waiter(line);
    },
  });
  const started = { dir, session, host, logs, logged };
  running.push(started);
  return started;
}

beforeAll(() => {
  relay = new FakeRelay();
  bridge = new RelayClientBridge(relay);
});

afterAll(async () => {
  await bridge.stop();
  await Promise.all(running.map(({ host }) => host.stop()));
  await Promise.all(running.map(({ session }) => session.dispose()));
  for (const { dir } of running.splice(0)) rmSync(dir, { recursive: true, force: true });
  await relay.stop();
});

const records = (dir: string) => new MeshStore(dir, { log: () => {} }).read()?.records;

describe("J-1: a link join run by the joiner's running host", () => {
  test("mesh pair on A, mesh join on B's host: both hold the welcome, the joiner's ack of its admission reaches the inviter on the kept session, and both files are equal", async () => {
    const a = await start("alpha", true);
    await relay.answers.next();
    const b = await start("beta", false);
    const offer = pendingFromWire(await requestControl(a.dir, { op: "mesh-pair", auto: true }));
    const identity = loadHostIdentity(a.dir);
    const link = buildPairingUrl({
      webOrigin: "https://doriface.example",
      hostId: identity.hostId,
      noiseStaticPub: identity.noise.publicKey,
      signPub: identity.sign.publicKey,
      linkSecret: offer.linkSecret,
      relayUrl: bridge.url,
      mesh: true,
    });
    const ackReached = a.logged(/^mesh: merged 1 records from /);
    const joined = await requestControl(b.dir, {
      op: "mesh-join",
      target: link,
      fingerprint: undefined,
      name: undefined,
      relay: undefined,
      yes: true,
    });
    const meshId = new MeshStore(a.dir, { log: () => {} }).read()?.meshId;
    expect(joined).toEqual({ meshId, hostId: identity.hostId });
    const welcome = records(a.dir)?.slice(0, 2);
    expect(welcome).toHaveLength(2);
    expect(records(b.dir)?.slice(0, 2)).toEqual(welcome);
    const [ownAck] = records(b.dir)?.slice(2) ?? [];
    await ackReached;
    expect(records(a.dir)).toEqual(records(b.dir));
    expect(ownAck === undefined ? undefined : parseRecord(ownAck)).toMatchObject({
      type: "ack",
      by: Buffer.from(loadHostIdentity(b.dir).sign.publicKey).toString("base64url"),
    });
    expect(
      new MeshStore(b.dir, { log: () => {} })
        .authorizeIndex()
        ?.member(Buffer.from(identity.noise.publicKey).toString("base64url")),
    ).toBeDefined();
  });
});
