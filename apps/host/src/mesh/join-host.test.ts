import { buildPairingUrl } from "@doriface/crypto";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateToken } from "../auth.ts";
import { meshJoinCommand, OFFER_WITHDRAWN_NOTICE } from "../commands/mesh-join.ts";
import { requestControl } from "../control.ts";
import { type Host, startHost } from "../host.ts";
import { parseRecord } from "@doriface/mesh";
import { loadHostIdentity } from "../state/host-keys.ts";
import { MeshStore } from "../state/mesh.ts";
import { PairingStore, pendingFromWire } from "../state/pairing.ts";
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
  test.each([false, undefined])("ask=%s closes before the card and leaves an asking offer unspent", async (ask) => {
    const a = await start("inviter", true);
    await relay.answers.next();
    const b = await start("joiner", false);
    const offer = pendingFromWire(await requestControl(a.dir, { op: "mesh-pair", auto: false }));
    const identity = loadHostIdentity(a.dir);
    const target = buildPairingUrl({
      webOrigin: "https://doriface.example",
      hostId: identity.hostId,
      noiseStaticPub: identity.noise.publicKey,
      signPub: identity.sign.publicKey,
      linkSecret: offer.linkSecret,
      relayUrl: bridge.url,
      mesh: true,
    });
    const result = await requestControl(b.dir, {
      op: "mesh-join",
      target,
      fingerprint: undefined,
      name: undefined,
      relay: undefined,
      yes: true,
      ask,
    }).then(
      () => "joined",
      (error: unknown) => String(error),
    );
    expect(result).toContain("this invite asks for a code");
    expect(result).toContain("terminal");
    expect(result).toContain("one-line command");
    expect(new PairingStore(a.dir).read()?.expiresAt).toBe(offer.expiresAt);
    expect(records(a.dir)).toHaveLength(1);
    expect(records(b.dir)).toBeUndefined();
  });

  test("an interactive join answers N through the running host even with yes", async () => {
    const a = await start("asking", true);
    await relay.answers.next();
    const b = await start("declining", false);
    const offer = pendingFromWire(await requestControl(a.dir, { op: "mesh-pair", auto: false }));
    const identity = loadHostIdentity(a.dir);
    const target = buildPairingUrl({
      webOrigin: "https://doriface.example",
      hostId: identity.hostId,
      noiseStaticPub: identity.noise.publicKey,
      signPub: identity.sign.publicKey,
      linkSecret: offer.linkSecret,
      relayUrl: bridge.url,
      mesh: true,
    });
    const codes: string[] = [];
    const result = await requestControl(
      b.dir,
      {
        op: "mesh-join",
        target,
        fingerprint: undefined,
        name: undefined,
        relay: undefined,
        yes: true,
        ask: true,
      },
      async (code) => {
        codes.push(code);
        return false;
      },
    ).then(
      () => "joined",
      (error: unknown) => String(error),
    );
    expect(result).toContain("not joined");
    expect(codes).toHaveLength(1);
    expect(records(a.dir)).toHaveLength(1);
    expect(records(b.dir)).toBeUndefined();
    expect(new PairingStore(a.dir).read()).toBeUndefined();
  });
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
    // B holds an open mesh invite of its own: the join withdraws it and says so in its reply (#2136).
    await requestControl(b.dir, { op: "mesh-pair", auto: false });
    const joined = await requestControl(b.dir, {
      op: "mesh-join",
      target: link,
      fingerprint: undefined,
      name: undefined,
      relay: undefined,
      yes: true,
    });
    const meshId = new MeshStore(a.dir, { log: () => {} }).read()?.meshId;
    expect(joined).toEqual({ meshId, hostId: identity.hostId, withdrewOffer: true });
    expect(new PairingStore(b.dir).read()).toBeUndefined();
    const welcome = records(a.dir)?.slice(0, 2);
    expect(welcome).toHaveLength(2);
    expect(records(b.dir)?.slice(0, 2)).toEqual(welcome);
    // The joiner acks its admission once the inviter's hello is read on the kept session (#159), so read it after that.
    await ackReached;
    const [ownAck] = records(b.dir)?.slice(2) ?? [];
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

describe("J-1b: a link join with no running host on the joiner", () => {
  test("a joiner holding its own open mesh invite says the join withdrew it, and keeps none (#2162)", async () => {
    const a = await start("inviting", true);
    await relay.answers.next();
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
    const dir = mkdtempSync(join(tmpdir(), "dh-join-host-offline-"));
    try {
      loadHostIdentity(dir);
      new PairingStore(dir).offer(Date.now(), true);
      // A stand-in for `hc connect` that answers the hello with this machine's core.
      const hc = join(dir, "hc");
      const hello = '{"jsonrpc":"2.0","id":0,"result":{"core":{"id":"core-offline","name":"offline"}}}';
      writeFileSync(hc, `#!/bin/sh\nread line\necho '${hello}'\n`);
      chmodSync(hc, 0o755);
      let said = "";
      await meshJoinCommand(
        ["join", link, "--yes", "--state-dir", dir, "--hc", hc],
        (text) => void (said += text),
        () => {},
      );
      expect(said.startsWith(OFFER_WITHDRAWN_NOTICE)).toBe(true);
      expect(said).toEndWith("start doriface-host to take part\n");
      expect(new PairingStore(dir).read()).toBeUndefined();
      const welcome = records(a.dir)?.slice(0, 2);
      expect(welcome).toHaveLength(2);
      expect(records(dir)?.slice(0, 2)).toEqual(welcome);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
