import { CloseCode, rawStaticKey, secureLink } from "@doriface/crypto";
import { memoryLinkPair } from "@doriface/crypto/testing";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Gateway } from "../gateway.ts";
import { CLIENT, gatewayOn, peerHello } from "../testing/gateway-harness.ts";
import { machine } from "../testing/mesh-history.ts";
import type { E2eeTransport } from "./accept.ts";
import type { E2eeWire } from "./links.ts";

/**
 * One interface, transports behind it: a client's hc line is judged the same way whether it arrives over this
 * computer's plain loopback socket, the LAN's `/v1/e2ee` or a relay session. Every assertion below runs once per
 * transport, so a rule added to one path and not the others fails here rather than in a user's hands.
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A client session over one transport: what it sends reaches the gate, and how the host ended it is read back. */
interface ClientSession {
  readonly send: (text: string) => Promise<void>;
  /** The close code the host ended the session with, once it did. */
  readonly closeCode: () => number | undefined;
  readonly settled: () => Promise<void>;
}

type Transport = "loopback" | "lan" | "relay";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "dh-symmetry-"));
  dirs.push(dir);
  const founder = machine("founder");
  const member = { ...machine("member"), hcId: "victim-core" };
  const phone = machine("phone");
  const made = gatewayOn(founder, member, { dir });
  made.devices.add(phone.identity.noise.publicKey, "phone");
  return { ...made, founder, phone };
}

/** The gateway's Bun websocket handler driven by hand: the loopback `/v1/hc` path, token already checked at upgrade. */
function loopback(gateway: Gateway): ClientSession {
  // Bun's handler type leaves every callback optional; this gateway serves both, and a test that found one missing
  // would otherwise hang on a session nobody opened.
  const { open, message } = gateway.websocket;
  if (open === undefined || message === undefined)
    throw new Error("the gateway's websocket handler has no open or message");
  let code: number | undefined;
  const closed = Promise.withResolvers<void>();
  const events = {};
  const ws = {
    data: { events },
    readyState: 1,
    isPaused: false,
    send: () => 1,
    close: (at?: number) => {
      code = at;
      closed.resolve();
    },
    pause() {},
    resume() {},
  };
  // The handler takes Bun's ServerWebSocket; this stand-in has the members WsLink and the gateway use.
  const socket = ws as unknown as Parameters<typeof open>[0];
  open(socket);
  return {
    send: async (text) => {
      message(socket, Buffer.from(text));
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
    closeCode: () => code,
    settled: () => Promise.race([closed.promise, new Promise<void>((resolve) => setTimeout(resolve, 200))]),
  };
}

/** A Noise session over a memory wire, served as the LAN listener or a relay session would hand it over. */
async function e2ee(made: ReturnType<typeof setup>, transport: E2eeTransport): Promise<ClientSession> {
  const [clientEnd, hostEnd] = memoryLinkPair();
  const wire: E2eeWire = {
    send: (bytes) => hostEnd.send(bytes),
    onData: (listener) => hostEnd.onData(listener),
    onClose: (listener) => hostEnd.onClose(listener),
    close: (code, reason) => hostEnd.close(code, reason),
    flushed: () => Promise.resolve(),
    readWhen() {},
  };
  const served = made.gateway.serveE2ee(wire, transport);
  const client = await secureLink(clientEnd, {
    role: "initiator",
    hostId: made.founder.identity.hostId,
    staticKey: rawStaticKey(made.phone.identity.noise),
    remoteStatic: made.founder.identity.noise.publicKey,
  });
  await served;
  const closed = Promise.withResolvers<void>();
  client.onClose(() => closed.resolve());
  return {
    send: async (text) => {
      client.send(encoder.encode(text));
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
    closeCode: () => hostEnd.closeCode,
    settled: () => Promise.race([closed.promise, new Promise<void>((resolve) => setTimeout(resolve, 200))]),
  };
}

const open = (made: ReturnType<typeof setup>, transport: Transport): Promise<ClientSession> =>
  transport === "loopback"
    ? Promise.resolve(loopback(made.gateway))
    : e2ee(made, transport === "lan" ? { kind: "lan" } : { kind: "relay" });

const TRANSPORTS: readonly Transport[] = ["loopback", "lan", "relay"];

describe("the same hc line is judged the same on every transport", () => {
  test.each(TRANSPORTS)("over %s, a client's plain hello reaches hc connect", async (transport) => {
    const made = setup();
    const session = await open(made, transport);
    await session.send(CLIENT);
    await made.pipe.reached;
    expect(made.pipe.text()).toContain('"method":"hello"');
    expect(session.closeCode()).toBeUndefined();
  });

  test.each(TRANSPORTS)(
    "over %s, a client announcing a member's core id is refused 4401 and hc gets nothing",
    async (transport) => {
      const made = setup();
      const session = await open(made, transport);
      await session.send(peerHello("victim-core"));
      await session.settled();
      expect(session.closeCode()).toBe(CloseCode.UnknownDevice);
      expect(made.pipe.piped).toEqual([]);
      expect(made.logs.some((line) => line.includes("a device announced a mesh member's core id"))).toBe(true);
    },
  );

  test.each(TRANSPORTS)(
    "over %s, a first line that is no hello is refused 4400 and hc gets nothing",
    async (transport) => {
      const made = setup();
      const session = await open(made, transport);
      await session.send('{"jsonrpc":"2.0","id":7,"method":"server.status"}\n');
      await session.settled();
      expect(session.closeCode()).toBe(CloseCode.CryptoFailure);
      expect(made.pipe.piped).toEqual([]);
      expect(decoder.decode(Buffer.concat(made.pipe.piped))).toBe("");
    },
  );
});
