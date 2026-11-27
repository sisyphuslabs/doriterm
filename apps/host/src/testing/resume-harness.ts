import { generateHostIdentity, generateX25519, rawStaticKey, secureLink, type SecureSession } from "@doriface/crypto";
import { CodedCloseError, type MemoryEnd, memoryLinkPair } from "@doriface/crypto/testing";
import { OPEN_POLICY } from "@doriface/policy";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { E2eeTransport } from "../e2ee/accept.ts";
import type { E2eeWire } from "../e2ee/links.ts";
import { LiveSessions } from "../e2ee/sessions.ts";
import { type ChildLink, createGateway } from "../gateway.ts";
import type { DataHandler } from "../link.ts";
import { DeviceStore } from "../state/devices.ts";
import { PairingStore } from "../state/pairing.ts";
import { CLIENT } from "./gateway-harness.ts";

// A gateway whose `hc connect` pipes echo, for the session resume tests (contract v1.11).
const encoder = new TextEncoder();
export const bytes = (text: string): Uint8Array => encoder.encode(text);
export const texts = (chunks: readonly Uint8Array[]): string[] =>
  chunks.map((chunk) => new TextDecoder().decode(chunk));
export const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

/** An `hc connect` that echoes every byte it is sent, and says when it was closed. */
export function echoChild() {
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

export const wireOf = (end: MemoryEnd): E2eeWire => ({
  send: (sent) => end.send(sent),
  onData: (listener) => end.onData(listener),
  onClose: (listener) => end.onClose(listener),
  close: (code, reason) => end.close(code, reason),
  flushed: () => Promise.resolve(),
  readWhen() {},
});

const dirs: string[] = [];
/** Removes every host's state directory; call from afterEach. */
const hosts: { readonly closeAll: () => Promise<void>; readonly clients: SecureSession[] }[] = [];
/**
 * Closes every host's gateway, so no session is left waiting on its resume timer, then removes their state directories;
 * call from afterEach.
 */
export async function cleanupResumeHosts(): Promise<void> {
  // A client leaving ends its live session the way a page closing does; the host stopping ends the waiting ones.
  await Promise.all(
    hosts.splice(0).map(async ({ closeAll, clients }) => {
      for (const client of clients) client.close();
      await closeAll();
    }),
  );
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A gateway with one paired device and echoing pipes, so what a session sends comes back to it. */
export function resumeHost(resumeGraceMs?: number) {
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
      live: { count: (replacing) => sessions.count(replacing) },
    },
  });
  const clients: SecureSession[] = [];
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
    clients.push(client);
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
  hosts.push({ closeAll: () => gateway.closeAll(), clients });
  return { gateway, logs, children, connect, redial };
}

export const dropped = (): CodedCloseError => new CodedCloseError(1006, "dropped");
