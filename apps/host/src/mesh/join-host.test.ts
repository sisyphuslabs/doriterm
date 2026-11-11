import { buildPairingUrl } from "@doriface/crypto";
import { HcConnection } from "@doriface/client";
import { type JsonValue, MESH_STATUS_DOC, parseMeshStatus } from "@doriface/protocol";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateToken } from "../auth.ts";
import { meshCommand } from "../commands/mesh.ts";
import { requestControl } from "../control.ts";
import { type Host, startHost } from "../host.ts";
import { parseRecord } from "@doriface/mesh";
import { loadHostIdentity } from "../state/host-keys.ts";
import { MeshStore } from "../state/mesh.ts";
import { PairingStore, pendingFromWire } from "../state/pairing.ts";
import { FakeRelay } from "../testing/fake-relay.ts";
import { createHcSession, HELLO, type HcSession } from "../testing/hc-session.ts";
import { RelayClientBridge } from "../testing/relay-client-bridge.ts";
import { openWsClient } from "../testing/ws-client.ts";
import { spawnHcLink } from "./hc-machines.ts";

setDefaultTimeout(60_000);

interface Running {
  readonly dir: string;
  readonly session: HcSession;
  readonly host: Host;
  readonly token: string;
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
  const token = generateToken();
  const host = await startHost({
    listen: { hostname: "127.0.0.1", port: 0 },
    token,
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
  const started = { dir, session, host, token, logs, logged };
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
  test("the first pending comparison is published without a mesh file, and denial clears its document", async () => {
    const a = await start("approval", true);
    await relay.answers.next();
    const b = await start("applicant", false);
    const client = await openWsClient(a.host.url, a.token);
    client.socket.send(HELLO);
    await client.reader.line();
    const link = spawnHcLink({ hc: a.session.hc, session: a.session.name, env: a.session.env });
    const core = await HcConnection.open(link);
    const feed = await core.subscribe();
    const documentWhen = (accept: (value: JsonValue) => boolean): Promise<JsonValue> => {
      const { promise, resolve, reject } = Promise.withResolvers<JsonValue>();
      const read = (): void => {
        void core.call("doc.get", { name: MESH_STATUS_DOC }).then(
          ({ value }) => {
            if (!accept(value)) return;
            unsubscribe();
            return resolve(value);
          },
          (error: unknown) => {
            unsubscribe();
            return reject(error);
          },
        );
      };
      const unsubscribe = feed.onEvent((event) => {
        if (event.type === "doc" && event.data.name === MESH_STATUS_DOC) read();
      });
      read();
      return promise;
    };
    try {
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
      const refused = a.logged(/^mesh: join refused:/);
      let observedStatus: ReturnType<typeof parseMeshStatus>;
      let observedDocument: ReturnType<typeof parseMeshStatus>;
      let persisted = true;
      let comparedCode: string | undefined;
      const result = await requestControl(
        b.dir,
        { op: "mesh-join", target, fingerprint: undefined, name: undefined, relay: undefined, yes: true, ask: true },
        async (code) => {
          comparedCode = code;
          observedStatus = parseMeshStatus(await requestControl(a.dir, { op: "mesh-status" }));
          persisted = new MeshStore(a.dir, { log: () => {} }).read() !== undefined;
          observedDocument = parseMeshStatus(
            await documentWhen(
              (value) => parseMeshStatus(value)?.pending.some((entry) => entry.code === code) === true,
            ),
          );
          return false;
        },
      ).then(
        () => "joined",
        (error: unknown) => String(error),
      );
      expect(result).toContain("not joined");
      expect(comparedCode).toBeDefined();
      expect(observedStatus?.pending).toMatchObject([{ code: comparedCode }]);
      expect(observedDocument?.pending).toMatchObject([{ code: comparedCode }]);
      expect(persisted).toBe(false);
      await refused;
      expect(await documentWhen((value) => value === null)).toBeNull();
    } finally {
      core.close();
      link.close();
      client.socket.close();
    }
  });

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
    expect(records(a.dir)).toBeUndefined();
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
    expect(records(a.dir)).toBeUndefined();
    expect(records(b.dir)).toBeUndefined();
    expect(new PairingStore(a.dir).read()).toBeUndefined();
    const output: string[] = [];
    expect(await meshCommand(["status", "--state-dir", a.dir], (text) => output.push(text))).toBe(1);
    expect(output.join("")).toContain("this host is in no mesh");
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
