import {
  type ByteLink,
  CloseCode,
  generateX25519,
  type KeyPair,
  type PairingSecret,
  pairingSlotOf,
  parsePairingUrl,
  rawStaticKey,
  type SecureLink,
  secureLink,
  SecureLinkError,
  SessionKind,
} from "@doriface/crypto";
import { pairSlotVerdict, encodeData } from "@doriface/relay-client";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateToken } from "../auth.ts";
import { type Host, startHost } from "../host.ts";
import { DeviceStore } from "../state/devices.ts";
import { loadHostIdentity } from "../state/host-keys.ts";
import { ByteReader } from "../testing/byte-reader.ts";
import { FakeRelay } from "../testing/fake-relay.ts";
import { createHcSession, HELLO, type HcSession, rpcFrame } from "../testing/hc-session.ts";

const CLI = join(import.meta.dir, "..", "cli.ts");
let stateDir: string;
let identity: ReturnType<typeof loadHostIdentity>;
let devices: DeviceStore;
const phone = generateX25519();
let relay: FakeRelay;
let session: HcSession;
let host: Host;
let firstAnswer: { readonly hostId: string; readonly verified: boolean };

const dial = (link: ByteLink, key: KeyPair, pairing?: PairingSecret) =>
  secureLink(link, {
    role: "initiator",
    hostId: identity.hostId,
    staticKey: rawStaticKey(key),
    remoteStatic: identity.noise.publicKey,
    pairing,
  });

function reader(link: SecureLink): ByteReader {
  const bytes = new ByteReader();
  link.onData((chunk) => bytes.push(chunk));
  link.onClose(() => bytes.end());
  return bytes;
}

async function refusal(attempt: Promise<SecureLink>): Promise<number | undefined> {
  const error = await attempt.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof SecureLinkError)) throw new Error(`expected a refusal, got ${String(error)}`);
  return error.code;
}

async function ackReaching(total: number): Promise<number> {
  const ack = await relay.acks.next();
  return ack >= total ? ack : ackReaching(total);
}

/** The next PAIR_SLOT is a registration of `slot` in the signed form, signed by this host for its Noise key (#22). */
async function expectSignedRegistration(slot: string): Promise<void> {
  const seen = await relay.pairSlots.next();
  if (seen === "clear") throw new Error(`expected a registration of ${slot}, got a clear`);
  expect(seen.slot).toBe(slot);
  expect(seen.noiseStaticPub).toEqual(identity.noise.publicKey);
  const signed = seen.signed;
  if (signed === undefined) throw new Error("expected the signed PAIR_SLOT form");
  const record = {
    hostId: identity.hostId,
    signPub: identity.sign.publicKey,
    noiseStaticPub: seen.noiseStaticPub,
    expiresAt: signed.expiresAt,
    slotSig: signed.signature,
  };
  expect(pairSlotVerdict(record, seen.slot, Date.now())).toBe("signed");
}

async function slotRegistered(slot: string): Promise<void> {
  const seen = await relay.pairSlots.next();
  if (seen === "clear" || seen.slot !== slot) return slotRegistered(slot);
}

async function pairOffer(): Promise<{ readonly code: string; readonly linkSecret: Uint8Array }> {
  const args = ["pair", "--no-qr", "--web-origin", "https://web.example", "--state-dir", stateDir];
  const proc = Bun.spawn([process.execPath, CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const url = stdout.split("\n").find((line) => line.startsWith("https://web.example/pair#"));
  if ((await proc.exited) !== 0 || url === undefined) throw new Error(`pair failed: ${stdout}`);
  const code = /^code\s+(\S{4}) (\S{4})/m.exec(stdout);
  if (code === null) throw new Error(`pair printed no code: ${stdout}`);
  return { code: `${code[1]}${code[2]}`, linkSecret: parsePairingUrl(url).linkSecret };
}

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "dh-relay-"));
  identity = loadHostIdentity(stateDir);
  devices = new DeviceStore(stateDir);
  relay = new FakeRelay();
  session = createHcSession("relay-uplink");
  devices.add(phone.publicKey, "phone");
  host = await startHost({
    listen: { hostname: "127.0.0.1", port: 0 },
    token: generateToken(),
    hc: session.hc,
    session: session.name,
    env: session.env,
    stateDir,
    relay: { url: relay.url },
    log: () => {},
  });
  firstAnswer = await relay.answers.next();
}, 30_000);

afterEach(async () => {
  await host.stop();
  await relay.stop();
  await session.dispose();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("the host's relay uplink", () => {
  test("answers the challenge with a signature bound to the relay origin it dialed", () => {
    expect(firstAnswer).toEqual({ hostId: identity.hostId, verified: true });
  });

  test("runs each relay session through its own Noise responder and hc connect", async () => {
    const [first, second] = await Promise.all([dial(relay.open(11), phone), dial(relay.open(12), phone)]);
    const [firstBytes, secondBytes] = [reader(first), reader(second)];
    first.send(HELLO);
    second.send(HELLO);
    for (const line of await Promise.all([firstBytes.line(), secondBytes.line()])) {
      expect(JSON.parse(new TextDecoder().decode(line)).result.framed).toBe(true);
    }
    first.close();
    second.send(rpcFrame(1, "terminal.list"));
    expect((await secondBytes.frame()).byteLength).toBeGreaterThan(9);
    second.close();
  });

  test("acks the total bytes the relay sent once 64 KiB have arrived", async () => {
    relay.sendRaw(encodeData(999, new Uint8Array(70_000)));
    expect(await ackReaching(relay.sentToHost)).toBe(relay.sentToHost);
  });

  test("refuses an OPEN past the contract's 8 pending sessions with CLOSE 4429, and an open session keeps working", async () => {
    const open = await dial(relay.open(21), phone);
    const bytes = reader(open);
    open.send(HELLO);
    await bytes.line();
    // Eight sessions that never get the host's first DATA are the pending cap; an honest relay would not open a ninth.
    const pending = Array.from({ length: 8 }, (_, index) => relay.open(30 + index));
    const extra = relay.open(38);
    try {
      expect(await extra.closed).toBe(CloseCode.RateLimited);
      open.send(rpcFrame(1, "terminal.list"));
      expect((await bytes.frame()).byteLength).toBeGreaterThan(9);
    } finally {
      for (const link of [...pending, extra]) link.close();
      open.close();
    }
  }, 20_000);

  test("refuses an unpaired device with a CLOSE 4401 the relay passes to the client", async () => {
    const link = relay.open(13);
    expect(await refusal(dial(link, generateX25519()))).toBe(CloseCode.UnknownDevice);
    expect(await link.closed).toBe(CloseCode.UnknownDevice);
  });
});

describe("pairing through the relay", () => {
  test("doriface-host pair registers the code's slot and the host's Noise key over the uplink", async () => {
    const { code } = await pairOffer();
    await expectSignedRegistration(pairingSlotOf(code));
  });

  test("a typed-code pairing on an ordinary session or another slot's session is refused with 4401", async () => {
    const { code } = await pairOffer();
    await expectSignedRegistration(pairingSlotOf(code));
    const pairing = { mode: "code", code, name: "guesser" } as const;
    const otherSlot = pairingSlotOf(code) === "ZZZ" ? "YYY" : "ZZZ";
    expect(await refusal(dial(relay.open(21), generateX25519(), pairing))).toBe(CloseCode.UnknownDevice);
    expect(await refusal(dial(relay.open(22, otherSlot), generateX25519(), pairing))).toBe(CloseCode.UnknownDevice);
  });

  test("on the code's slot the device pairs, is stored, and the slot is released", async () => {
    const { code } = await pairOffer();
    await expectSignedRegistration(pairingSlotOf(code));
    const tablet = generateX25519();
    const paired = await dial(relay.open(23, pairingSlotOf(code)), tablet, { mode: "code", code, name: "tablet" });
    expect(paired.kind).toBe(SessionKind.PairCode);
    expect(await relay.pairSlots.next()).toBe("clear");
    expect(devices.has(tablet.publicKey)).toBe(true);
    paired.close();
  });

  test("a link secret pairs on an ordinary relay session", async () => {
    const { code: offered, linkSecret } = await pairOffer();
    await expectSignedRegistration(pairingSlotOf(offered));
    const laptop = generateX25519();
    const paired = await dial(relay.open(24), laptop, { mode: "link", linkSecret, name: "laptop" });
    expect(paired.kind).toBe(SessionKind.PairLink);
    expect(await relay.pairSlots.next()).toBe("clear");
    expect(devices.has(laptop.publicKey)).toBe(true);
    paired.close();
  });

  test("a reconnected uplink registers the pending code's slot again", async () => {
    const { code: next } = await pairOffer();
    await expectSignedRegistration(pairingSlotOf(next));
    relay.dropUplink(1011);
    expect(await relay.answers.next()).toEqual({ hostId: identity.hostId, verified: true });
    await expectSignedRegistration(pairingSlotOf(next));
  });
});

describe("shutdown", () => {
  test("stop releases the pending pairing slot over the uplink before closing it", async () => {
    const { code } = await pairOffer();
    const slot = pairingSlotOf(code);
    await slotRegistered(slot);
    await host.stop();
    expect(await relay.pairSlots.next()).toBe("clear");
  });
});
