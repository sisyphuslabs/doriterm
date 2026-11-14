import { HELLO_REQUEST_LINE } from "@doriface/client";
import { base64urlEncode, type ByteLink, CloseCode, generateX25519, rawStaticKey, secureLink } from "@doriface/crypto";
import { parsePolicy } from "@doriface/policy";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateToken } from "./auth.ts";
import { type Host, startHost } from "./host.ts";
import { LiveSessions } from "./e2ee/sessions.ts";
import { DeviceStore } from "./state/devices.ts";
import { loadHostIdentity } from "./state/host-keys.ts";
import { type E2eeClient, openE2eeClient } from "./testing/e2ee-client.ts";
import { createHcSession, type HcSession, rpcFrame } from "./testing/hc-session.ts";

// Admission of an early-hello session against a real host and hc, under a plan of one session (#1271): what a captured
// message 1 can and cannot cause before the client proves it holds the session's keys.
setDefaultTimeout(30_000);
const HELLO_LINE = new TextEncoder().encode(HELLO_REQUEST_LINE);
const stateDir = mkdtempSync(join(tmpdir(), "dh-admission-"));
const device = generateX25519();
const other = generateX25519();
let session: HcSession;
let host: Host;

const url = (): string => {
  const e2ee = host.e2ee;
  if (e2ee === undefined) throw new Error("the host has no e2ee endpoint");
  return e2ee.url;
};
const identity = () => loadHostIdentity(stateDir);

/** A raw socket to the host's /v1/e2ee: what a replayer has. Resolves with every message it got and its close code. */
async function raw(first: Uint8Array): Promise<{ readonly messages: Uint8Array[]; readonly closed: Promise<number> }> {
  const socket = new WebSocket(url());
  socket.binaryType = "arraybuffer";
  const messages: Uint8Array[] = [];
  const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
  socket.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.data instanceof ArrayBuffer) messages.push(new Uint8Array(event.data));
  });
  await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve(), { once: true }));
  socket.send(first);
  return { messages, closed };
}

/** A real client's message 1 carrying the early hello, captured as it leaves; the client never goes further. */
async function captureMessage1(key = device): Promise<Uint8Array> {
  const captured = Promise.withResolvers<Uint8Array>();
  const link: ByteLink = {
    send: (bytes) => captured.resolve(bytes.slice()),
    onData: () => () => undefined,
    onClose: () => () => undefined,
    close: () => undefined,
  };
  void secureLink(link, {
    role: "initiator",
    hostId: identity().hostId,
    staticKey: rawStaticKey(key),
    remoteStatic: identity().noise.publicKey,
    early: HELLO_LINE,
    timeoutMs: 50,
  }).catch(() => undefined);
  return captured.promise;
}

/** A client as the app is now: hello inside message 1, its answer read without sending it again, then one RPC. */
async function realClient(key = device): Promise<{ readonly hello: unknown; readonly list: Uint8Array }> {
  const client = await openE2eeClient(url(), {
    hostId: identity().hostId,
    staticKey: rawStaticKey(key),
    remoteStatic: identity().noise.publicKey,
    early: HELLO_LINE,
  });
  try {
    const hello: unknown = JSON.parse(new TextDecoder().decode(await client.reader.line()));
    client.link.send(rpcFrame(1, "terminal.list"));
    const list = await client.reader.frame();
    client.link.close();
    await client.closed;
    return { hello, list };
  } catch (error) {
    throw new Error(`closed with ${await client.closed}: ${String(error)}`, { cause: error });
  }
}

beforeAll(async () => {
  session = createHcSession("doriface-admission-test");
  host = await startHost({
    listen: { hostname: "127.0.0.1", port: 0 },
    token: generateToken(),
    hc: session.hc,
    session: session.name,
    env: session.env,
    stateDir,
    lanListen: { hostname: "127.0.0.1", port: 0 },
    policy: parsePolicy('{"plan":"free","limits":{"sessions":1}}'),
    log: () => undefined,
  });
  const devices = new DeviceStore(stateDir);
  devices.add(device.publicKey, "laptop");
  devices.add(other.publicKey, "phone");
});

afterAll(async () => {
  await host.stop();
  await session.dispose();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("early-hello admission (#1271)", () => {
  test("on a cold host a captured message 1 gets message 2 only: nothing is started for it, and it closes 4408", async () => {
    const replay = await raw(await captureMessage1());
    expect(await replay.closed).toBe(CloseCode.IdleTimeout);
    expect(replay.messages).toHaveLength(1);
  });

  test("a real client is admitted, its hello answered once, and its RPC carried", async () => {
    const { hello, list } = await realClient();
    expect(hello).toMatchObject({ id: 0, result: { framed: true } });
    expect(list.byteLength).toBeGreaterThan(0);
  });

  test("captured message 1 replays on new connections hold no session: a real client is still admitted under a limit of one", async () => {
    const captured = await captureMessage1();
    const replays = await Promise.all([raw(captured), raw(captured)]);
    const { hello, list } = await realClient();
    expect(hello).toMatchObject({ result: { framed: true } });
    // The first client on a warm host: its hello was answered early, and its RPC still comes through, once.
    expect(new TextDecoder().decode(list)).toContain('"id":1');
    expect(await Promise.all(replays.map((replay) => replay.closed))).toEqual([
      CloseCode.IdleTimeout,
      CloseCode.IdleTimeout,
    ]);
  });

  test("two proven handshakes racing for one session slot: one is admitted, the other closes 4429", async () => {
    const settled = await Promise.allSettled([realClient(device), realClient(other)]);
    expect(settled.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const refused = settled.find((outcome) => outcome.status === "rejected");
    expect(refused?.status === "rejected" ? String(refused.reason) : "").toContain(String(CloseCode.RateLimited));
  });

  test("a device revoked between message 1 and its confirmation is never admitted: its RPC gets no answer", async () => {
    const held: Uint8Array[] = [];
    const socket = new WebSocket(url());
    socket.binaryType = "arraybuffer";
    const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
    await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve(), { once: true }));
    let sends = 0;
    const answers: Uint8Array[] = [];
    const link: ByteLink = {
      send: (bytes) => {
        sends += 1;
        if (sends === 1) socket.send(bytes);
        else held.push(bytes.slice());
      },
      onData(listener) {
        const handle = (event: MessageEvent<unknown>): void => {
          if (event.data instanceof ArrayBuffer) listener(new Uint8Array(event.data));
        };
        socket.addEventListener("message", handle);
        return () => socket.removeEventListener("message", handle);
      },
      onClose: () => () => undefined,
      close: (code, reason) => socket.close(code, reason),
    };
    const client = await secureLink(link, {
      role: "initiator",
      hostId: identity().hostId,
      staticKey: rawStaticKey(other),
      remoteStatic: identity().noise.publicKey,
      early: HELLO_LINE,
    });
    client.onData((bytes) => answers.push(bytes));
    client.send(rpcFrame(1, "terminal.list"));
    new DeviceStore(stateDir).revoke(base64urlEncode(other.publicKey));
    for (const bytes of held.splice(0)) socket.send(bytes);
    expect(await closed).toBe(CloseCode.UnknownDevice);
    const replies = new TextDecoder().decode(Buffer.concat(answers));
    expect(replies.includes('"id":1')).toBe(false);
  });

  test("a device revoked after admission before its first RPC gets no answer (#2530)", async () => {
    const key = generateX25519();
    const devices = new DeviceStore(stateDir);
    devices.add(key.publicKey, "revoked-after-admission");
    const admitted = Promise.withResolvers<void>();
    const admitHc = LiveSessions.prototype.admitHc;
    const admission = spyOn(LiveSessions.prototype, "admitHc").mockImplementation(function (
      this: LiveSessions,
      secure,
      policy,
    ) {
      const accepted = admitHc.call(this, secure, policy);
      if (accepted && base64urlEncode(secure.remoteStatic) === base64urlEncode(key.publicKey)) admitted.resolve();
      return accepted;
    });
    let client: E2eeClient | undefined;
    try {
      client = await openE2eeClient(url(), {
        hostId: identity().hostId,
        staticKey: rawStaticKey(key),
        remoteStatic: identity().noise.publicKey,
        early: HELLO_LINE,
      });
      // Hold the first RPC until the host has admitted this exact key, then revoke
      // before releasing it. Neither the hello's timing nor a sleep orders this.
      await admitted.promise;
      const answered = Promise.withResolvers<void>();
      const answers: Uint8Array[] = [];
      client.link.onData((bytes) => {
        answers.push(bytes);
        if (new TextDecoder().decode(bytes).includes('"id":1')) answered.resolve();
      });
      expect(devices.revoke(base64urlEncode(key.publicKey))).toHaveLength(1);
      client.link.send(rpcFrame(1, "terminal.list"));
      await Promise.race([client.closed, answered.promise]);
      const replies = new TextDecoder().decode(Buffer.concat(answers));
      expect(replies.includes('"id":1')).toBe(false);
      expect(await client.closed).toBe(CloseCode.UnknownDevice);
    } finally {
      admission.mockRestore();
      client?.link.close();
      await client?.closed;
    }
  });
});
