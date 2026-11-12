import {
  CloseCode,
  encodeResumeRequest,
  generateHostIdentity,
  generateX25519,
  rawStaticKey,
  resumeKeys,
  secureLink,
  type SecureSession,
} from "@doriface/crypto";
import { CodedCloseError, type MemoryEnd, memoryLinkPair } from "@doriface/crypto/testing";
import { OPEN_POLICY } from "@doriface/policy";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChildLink, createGateway } from "../gateway.ts";
import type { DataHandler } from "../link.ts";
import { DeviceStore } from "../state/devices.ts";
import { PairingStore } from "../state/pairing.ts";
import { CLIENT } from "../testing/gateway-harness.ts";
import type { E2eeTransport } from "./accept.ts";
import type { E2eeWire } from "./links.ts";
import { LiveSessions } from "./sessions.ts";

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);
const texts = (chunks: readonly Uint8Array[]): string[] => chunks.map((chunk) => new TextDecoder().decode(chunk));
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

/** An `hc connect` that echoes every byte it is sent, and says when it was closed. */
function echoChild() {
  let handler: DataHandler | undefined;
  const closeHandlers: (() => void)[] = [];
  const exited = Promise.withResolvers<void>();
  const state = { closed: false, received: 0 };
  const child: ChildLink = {
    exited: exited.promise,
    send: async (sent) => {
      state.received += sent.byteLength;
      await handler?.(sent);
    },
    onData: (next) => {
      handler = next;
    },
    onClose: (next) => closeHandlers.push(next),
    close: () => {
      if (state.closed) return;
      state.closed = true;
      exited.resolve();
      for (const next of closeHandlers.splice(0)) next();
    },
  };
  return { child, state };
}

const wireOf = (end: MemoryEnd): E2eeWire => ({
  send: (sent) => end.send(sent),
  onData: (listener) => end.onData(listener),
  onClose: (listener) => end.onClose(listener),
  close: (code, reason) => end.close(code, reason),
  flushed: () => Promise.resolve(),
  readWhen() {},
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A gateway with one paired device and echoing pipes, so what a session sends comes back to it. */
function host(resumeGraceMs?: number) {
  const dir = mkdtempSync(join(tmpdir(), "dh-resume-"));
  dirs.push(dir);
  const logs: string[] = [];
  const log = (line: string): void => void logs.push(line);
  const identity = generateHostIdentity();
  const device = generateX25519();
  const devices = new DeviceStore(dir);
  devices.add(device.publicKey, "phone");
  const sessions = new LiveSessions(devices, log);
  const children: ReturnType<typeof echoChild>[] = [];
  const gateway = createGateway({
    token: "t".repeat(32),
    hostVersion: "0",
    hcVersion: "0",
    openPipe: () => {
      const child = echoChild();
      children.push(child);
      return child.child;
    },
    log,
    resumeGraceMs,
    e2ee: {
      identity,
      devices,
      pairing: new PairingStore(dir, log),
      log,
      lanUrls: [],
      policy: OPEN_POLICY,
      sessions,
      live: { count: () => sessions.count() },
    },
  });
  const connect = async (transport: E2eeTransport = { kind: "relay" }) => {
    const [clientEnd, hostEnd] = memoryLinkPair();
    const served = gateway.serveE2ee(wireOf(hostEnd), transport);
    const client: SecureSession = await secureLink(clientEnd, {
      role: "initiator",
      hostId: identity.hostId,
      staticKey: rawStaticKey(device),
      remoteStatic: identity.noise.publicKey,
      early: bytes(CLIENT),
    });
    await served;
    client.allowResume();
    const received: Uint8Array[] = [];
    client.onData((chunk) => received.push(chunk));
    return { client, clientEnd, hostEnd, received };
  };
  /** A client's fresh socket to the host, served as the relay would hand it over. */
  const redial = (transport: E2eeTransport = { kind: "relay" }) => {
    const [clientEnd, hostEnd] = memoryLinkPair();
    const served = gateway.serveE2ee(wireOf(hostEnd), transport);
    return { clientEnd, hostEnd, served };
  };
  return { gateway, logs, children, connect, redial };
}

const dropped = (): CodedCloseError => new CodedCloseError(1006, "dropped");

/** The transports a session can run on; a resume is the same exchange on each (the loopback socket carries no session). */
const TRANSPORTS: readonly E2eeTransport[] = [{ kind: "relay" }, { kind: "lan" }];

describe("an hc session whose link drops", () => {
  test.each(TRANSPORTS)(
    "over %p keeps its hc connect, and the client's resume carries on with what was typed meanwhile, exactly once",
    async (transport) => {
      const h = host();
      const { client, clientEnd, hostEnd, received } = await h.connect(transport);
      client.send(bytes("one\n"));
      await flush();
      expect(texts(received)).toEqual(["one\n"]);
      clientEnd.end(dropped());
      hostEnd.end(dropped());
      await flush();
      expect(h.children.length).toBe(1);
      expect(h.children[0]?.state.closed).toBe(false);
      expect(client.detached).toBe(true);
      client.send(bytes("two\n"));
      const again = h.redial(transport);
      await client.resume(again.clientEnd);
      await again.served;
      client.send(bytes("three\n"));
      await flush();
      expect(texts(received)).toEqual(["one\n", "two\n", "three\n"]);
      expect(h.children.length).toBe(1);
      expect(h.logs.some((line) => line.startsWith("session detached"))).toBe(true);
      expect(h.logs).toContain("session resumed on a new link");
    },
  );

  test("ends, hc connect with it, once the resume window passed; a resume after that is refused with 4413", async () => {
    const h = host(40);
    const { client, clientEnd, hostEnd } = await h.connect();
    clientEnd.end(dropped());
    hostEnd.end(dropped());
    await flush();
    expect(h.children[0]?.state.closed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(h.children[0]?.state.closed).toBe(true);
    const again = h.redial();
    const failed = await client.resume(again.clientEnd).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(Error);
    await again.served;
    expect(again.hostEnd.closeCode).toBe(CloseCode.ResumeRefused);
    expect(h.children.length).toBe(1);
  });

  test("a normal close ends the session at once, and the former link's late close after a resume means nothing", async () => {
    const h = host();
    const polite = await h.connect();
    polite.clientEnd.close();
    await flush();
    expect(h.children[0]?.state.closed).toBe(true);

    const { client, clientEnd, hostEnd, received } = await h.connect();
    // The client's socket died under it, but the host's side of the old link is still open (half-open).
    clientEnd.end(dropped());
    await flush();
    const again = h.redial();
    await client.resume(again.clientEnd);
    await again.served;
    await flush();
    expect(hostEnd.closeCode).toBe(1000);
    client.send(bytes("after\n"));
    await flush();
    expect(texts(received)).toEqual(["after\n"]);
    expect(h.children.length).toBe(2);
    expect(h.children[1]?.state.closed).toBe(false);
  });
});

describe("a host that stops", () => {
  test("ends a session waiting for its client at once, hc connect with it", async () => {
    const h = host();
    const { clientEnd, hostEnd } = await h.connect();
    clientEnd.end(dropped());
    hostEnd.end(dropped());
    await flush();
    expect(h.children[0]?.state.closed).toBe(false);
    await h.gateway.closeAll();
    expect(h.children[0]?.state.closed).toBe(true);
  });
});

describe("a resume request the host cannot honour", () => {
  test("for a session it does not hold is refused with 4413, and starts no hc connect", async () => {
    const h = host();
    const stranger = resumeKeys(new Uint8Array(32).fill(7));
    const [clientEnd, hostEnd] = memoryLinkPair();
    const served = h.gateway.serveE2ee(wireOf(hostEnd), { kind: "relay" });
    clientEnd.send(encodeResumeRequest(stranger, { sent: 1, received: 0 }));
    await served;
    await flush();
    expect(clientEnd.closeCode === undefined ? hostEnd.closeCode : clientEnd.closeCode).toBe(CloseCode.ResumeRefused);
    expect(h.children.length).toBe(0);
    expect(h.logs).toContain("resume refused: no such session");
  });
});
