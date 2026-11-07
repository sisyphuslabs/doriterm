import { HELLO_REQUEST_LINE } from "@doriface/client";
import {
  type ByteLink,
  CloseCode,
  generateX25519,
  type KeyPair,
  formatPairingCode,
  normalizePairingCode,
  type PairingSecret,
  rawStaticKey,
  pairingSlotOf,
  parsePairingUrl,
  SecureLinkError,
  secureLink,
  SessionKind,
} from "@doriface/crypto";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateToken } from "./auth.ts";
import { type Host, startHost } from "./host.ts";
import { openE2eeClient, type E2eeClient } from "./testing/e2ee-client.ts";
import { createHcSession, HELLO, type HcSession, rpcFrame } from "./testing/hc-session.ts";

const CLI = join(import.meta.dir, "cli.ts");
/** These tests spawn the CLI; a cold transpiler cache alone can take most of bun's 5 s default. */
setDefaultTimeout(30_000);
const device = generateX25519();
const stateDir = mkdtempSync(join(tmpdir(), "dh-e2ee-"));
let session: HcSession;
let host: Host;
const logWaiters = new Set<(line: string) => void>();
/** Resolves with the first host log line matching `pattern` from now on; subscribe before the action. */
function nextLog(pattern: RegExp): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const timer = setTimeout(() => reject(new Error(`no log line matching ${pattern}`)), 5000);
  const waiter = (line: string): void => {
    if (!pattern.test(line)) return;
    clearTimeout(timer);
    logWaiters.delete(waiter);
    resolve(line);
  };
  logWaiters.add(waiter);
  return promise;
}
/** A relay stand-in: the first slot collides (409), later ones register. */
const slots: { readonly asked: string[]; readonly keys: Uint8Array[]; readonly released: string[] } = {
  asked: [],
  keys: [],
  released: [],
};
const releaseWaiters = new Map<string, () => void>();
/** Resolves when the host releases `slot`; subscribe before the action that should release it. */
function released(slot: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(() => reject(new Error(`slot ${slot} was not released`)), 5000);
  releaseWaiters.set(slot, () => {
    clearTimeout(timer);
    resolve();
  });
  return promise;
}
const registrar = {
  register: (slot: string, noiseStaticPub: Uint8Array) => {
    slots.asked.push(slot);
    slots.keys.push(noiseStaticPub);
    return Promise.resolve(slots.asked.length === 1 ? ("collision" as const) : ("registered" as const));
  },
  release: (slot: string) => {
    slots.released.push(slot);
    releaseWaiters.get(slot)?.();
  },
};

async function cli(...args: string[]): Promise<{ readonly code: number; readonly stdout: string }> {
  const proc = Bun.spawn([process.execPath, CLI, ...args, "--state-dir", stateDir], { stdout: "pipe", stderr: "pipe" });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, stdout };
}

function endpoint() {
  const e2ee = host.e2ee;
  if (e2ee === undefined) throw new Error("the host has no e2ee endpoint");
  return e2ee;
}

function lanEndpoint(): string {
  const [lanUrl] = endpoint().lanUrls;
  if (lanUrl === undefined) throw new Error("no LAN listener");
  return lanUrl;
}

type Offer = ReturnType<typeof parsePairingUrl> & { readonly code: string };
let pairing: Offer;
let pairOutput = "";

/** Runs `doriface-host pair` and reads back the link and the typed code it printed. */
async function pair(): Promise<Offer> {
  const paired = await cli("pair", "--no-qr", "--web-origin", "https://web.example");
  const lines = paired.stdout.split("\n");
  const url = lines.find((line) => line.startsWith("https://web.example/pair#"));
  const typed = paired.stdout.match(/^code +(\S{4} \S{4})/m)?.[1];
  if (paired.code !== 0 || url === undefined || typed === undefined) throw new Error(`pair failed: ${paired.stdout}`);
  pairOutput = paired.stdout;
  return { ...parsePairingUrl(url), code: normalizePairingCode(typed) };
}

const viaLink = (name: string, offer: Offer = pairing): PairingSecret => ({
  mode: "link",
  linkSecret: offer.linkSecret,
  name,
});

const dial = (staticKey: KeyPair, pairingWith?: PairingSecret) =>
  openE2eeClient(endpoint().url, {
    hostId: pairing.hostId,
    staticKey: rawStaticKey(staticKey),
    remoteStatic: pairing.noiseStaticPub,
    pairing: pairingWith,
  });

/**
 * A session whose client never confirms the keys, as a replayed message 1 would be: every send after message 1 is
 * dropped. `early` rides in message 1. Resolves with what the host sent back after message 2, and the close code.
 */
async function unconfirmed(early: Uint8Array): Promise<{ readonly answer: Uint8Array[]; readonly code: number }> {
  const socket = new WebSocket(endpoint().url);
  socket.binaryType = "arraybuffer";
  const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
  await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve(), { once: true }));
  let sent = 0;
  const answer: Uint8Array[] = [];
  const link: ByteLink = {
    send: (bytes) => {
      sent += 1;
      if (sent === 1) socket.send(bytes);
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
  const secure = await secureLink(link, {
    role: "initiator",
    hostId: pairing.hostId,
    staticKey: rawStaticKey(device),
    remoteStatic: pairing.noiseStaticPub,
    early,
  });
  secure.onData((bytes) => answer.push(bytes));
  return { answer, code: await closed };
}

/** A plain-mode JSON-RPC line that is not a hello. */
const rpcFrameLine = (method: string): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method })}\n`);

async function refusal(attempt: Promise<E2eeClient>): Promise<number | undefined> {
  const error = await attempt.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof SecureLinkError)) throw new Error(`expected a refusal, got ${String(error)}`);
  return error.code;
}

beforeAll(async () => {
  session = createHcSession("doriface-e2ee-test");
  host = await startHost({
    listen: { hostname: "127.0.0.1", port: 0 },
    token: generateToken(),
    hc: session.hc,
    session: session.name,
    env: session.env,
    stateDir,
    lanListen: { hostname: "127.0.0.1", port: 0 },
    pairingSlots: registrar,
    log: (line) => {
      for (const waiter of logWaiters) waiter(line);
    },
  });
  pairing = await pair();
});

afterAll(async () => {
  await host.stop();
  await session.dispose();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("/v1/e2ee against a real hc", () => {
  test("pair prints a link for this host and keeps its state owner-only", () => {
    expect(pairing.hostId).toBe(endpoint().hostId);
    expect(pairing.relayUrl).toBe("wss://relay-doriface.omo.dev");
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(stateDir, "host-keys.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(stateDir, "pairing.json")).mode & 0o777).toBe(0o600);
    expect(pairOutput).toContain(`\nfingerprint ${endpoint().fingerprint}\n`);
  });

  test("a relay slot collision draws a new code before pair prints it", () => {
    expect(slots.asked).toHaveLength(2);
    expect(slots.asked[1]).toBe(pairingSlotOf(pairing.code));
    expect(slots.keys.every((key) => key.toHex() === pairing.noiseStaticPub.toHex())).toBe(true);
    expect(pairOutput).toContain(`\ncode        ${formatPairingCode(pairing.code)}\n`);
  });

  test("fingerprint prints the host fingerprint in ten groups of four", async () => {
    const printed = await cli("fingerprint");
    expect(printed).toEqual({ code: 0, stdout: `${endpoint().fingerprint}\n` });
    expect(printed.stdout).toMatch(/^([0-9A-F]{4} ){9}[0-9A-F]{4}\n$/);
  });

  test("a typed code on the direct path is refused 4401 before the host answers, and counts no attempt", async () => {
    const typed = dial(generateX25519(), { mode: "code", code: pairing.code, name: "typed" });
    expect(await refusal(typed)).toBe(CloseCode.UnknownDevice);
    expect(JSON.parse(readFileSync(join(stateDir, "pairing.json"), "utf8"))).toMatchObject({ codeAttempts: 0 });
  });

  test("a device pairs once with the link secret; the offer then refuses anyone else with 4401", async () => {
    const used = released(pairingSlotOf(pairing.code));
    const stored = nextLog(/^paired device "test phone"$/);
    const first = await dial(device, viaLink("test phone"));
    expect(first.link.kind).toBe(SessionKind.PairLink);
    expect(first.link.lanUrls).toEqual([lanEndpoint()]);
    first.link.close();
    await stored;
    const listed = await cli("devices", "list");
    expect(listed.stdout).toMatch(/^[0-9A-F]{8} {2}\S+ {2}test phone\n$/);
    await used;
    expect(slots.released).toEqual([pairingSlotOf(pairing.code)]);
    const second = dial(generateX25519(), viaLink("intruder"));
    expect(await refusal(second)).toBe(CloseCode.UnknownDevice);
    expect(statSync(join(stateDir, "devices.json")).mode & 0o777).toBe(0o600);
  });

  test("an IK reconnect carries hello and terminal.list byte-identical to a direct hc connect", async () => {
    const client = await dial(device);
    expect(client.link.kind).toBe(SessionKind.Session);
    client.link.send(HELLO);
    const helloViaE2ee = await client.reader.line();
    client.link.send(rpcFrame(1, "terminal.list"));
    const listViaE2ee = await client.reader.frame();

    const direct = session.connect();
    await direct.write(HELLO);
    const helloDirect = await direct.reader.line();
    await direct.write(rpcFrame(1, "terminal.list"));
    const listDirect = await direct.reader.frame();
    direct.end();
    await direct.exited;

    expect(JSON.parse(new TextDecoder().decode(helloViaE2ee)).result.framed).toBe(true);
    expect(helloViaE2ee).toEqual(helloDirect);
    expect(listViaE2ee).toEqual(listDirect);
    console.log(
      `byte-identical over e2ee: hello ${helloViaE2ee.byteLength} B, terminal.list ${listViaE2ee.byteLength} B`,
    );
    client.link.close();
  });

  test("wrong link secrets leave the offer usable; the right one pairs and releases the relay slot", async () => {
    const offer = await pair();
    const used = released(pairingSlotOf(offer.code));
    const stored = nextLog(/^paired device "second phone"$/);
    const guesses = [1, 2, 3, 4].map((attempt) =>
      refusal(
        dial(generateX25519(), {
          mode: "link",
          linkSecret: crypto.getRandomValues(new Uint8Array(32)),
          name: `guesser ${attempt}`,
        }),
      ),
    );
    expect(await Promise.all(guesses)).toEqual([4, 4, 4, 4].map(() => CloseCode.CryptoFailure));
    const right = await dial(generateX25519(), viaLink("second phone", offer));
    expect(right.link.kind).toBe(SessionKind.PairLink);
    right.link.close();
    await Promise.all([used, stored]);
    expect(existsSync(join(stateDir, "pairing.json"))).toBe(false);
  });

  test("an unpaired key is refused with 4401", async () => {
    expect(await refusal(dial(generateX25519()))).toBe(CloseCode.UnknownDevice);
  });

  test("the LAN listener serves /v1/e2ee but never the plaintext /v1/hc", async () => {
    const lanUrl = lanEndpoint();
    const plaintext = await fetch(lanUrl.replace("ws://", "http://").replace("/v1/e2ee", "/v1/hc"));
    expect(plaintext.status).toBe(404);
    const client = await openE2eeClient(lanUrl, {
      hostId: pairing.hostId,
      staticKey: rawStaticKey(device),
      remoteStatic: pairing.noiseStaticPub,
    });
    client.link.send(HELLO);
    expect(JSON.parse(new TextDecoder().decode(await client.reader.line())).result.framed).toBe(true);
    client.link.close();
  });

  test("hc's hello in message 1 is answered with message 2, before the keys are confirmed (#1271)", async () => {
    const { answer, code } = await unconfirmed(new TextEncoder().encode(HELLO_REQUEST_LINE));
    const reply = JSON.parse(new TextDecoder().decode(Buffer.concat(answer)).split("\n")[0] ?? "");
    expect(reply.result.framed).toBe(true);
    expect(code).toBe(CloseCode.IdleTimeout);
  });

  test("early bytes other than the hello line still wait for the confirmation, so an unconfirmed session gets nothing", async () => {
    const { answer, code } = await unconfirmed(rpcFrameLine("terminal.list"));
    expect(answer).toEqual([]);
    expect(code).toBe(CloseCode.IdleTimeout);
  });

  test("with every speculative slot held by unconfirmed hellos, a fifth client is not kept waiting: its hello is answered once and its RPC carried", async () => {
    const hello = new TextEncoder().encode(HELLO_REQUEST_LINE);
    const held = [0, 1, 2, 3].map(() => unconfirmed(hello));
    const client = await openE2eeClient(endpoint().url, {
      hostId: pairing.hostId,
      staticKey: rawStaticKey(device),
      remoteStatic: pairing.noiseStaticPub,
      early: hello,
    });
    expect(JSON.parse(new TextDecoder().decode(await client.reader.line())).result.framed).toBe(true);
    client.link.send(rpcFrame(1, "terminal.list"));
    expect(new TextDecoder().decode(await client.reader.frame())).toContain('"id":1');
    client.link.close();
    const unanswered = await Promise.all(held);
    expect(unanswered.every(({ code }) => code === CloseCode.IdleTimeout)).toBe(true);
    expect(unanswered.filter(({ answer }) => answer.length > 0).length).toBeLessThanOrEqual(4);
  });

  test("devices revoke closes the live session with 4401 and refuses the next one", async () => {
    const live = await dial(device);
    live.link.send(HELLO);
    await live.reader.line();
    const id = (await cli("devices", "list")).stdout.slice(0, 8);
    const revoked = await cli("devices", "revoke", id);
    expect(revoked).toEqual({ code: 0, stdout: `revoked ${id}  test phone\n` });
    expect(await live.closed).toBe(CloseCode.UnknownDevice);
    expect(await refusal(dial(device))).toBe(CloseCode.UnknownDevice);
  });
});
