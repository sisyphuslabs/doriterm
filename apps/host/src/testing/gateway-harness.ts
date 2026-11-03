import { rawStaticKey, type SecureLink, secureLink } from "@doriface/crypto";
import { memoryLinkPair } from "@doriface/crypto/testing";
import { type ChildLink, createGateway } from "../gateway.ts";
import type { E2eeWire } from "../e2ee/links.ts";
import { LiveSessions } from "../e2ee/sessions.ts";
import { DeviceStore } from "../state/devices.ts";
import type { MeshStore } from "../state/mesh.ts";
import { PairingStore } from "../state/pairing.ts";
import { type Machine, MeshFixture } from "./mesh-history.ts";

const encoder = new TextEncoder();

/** The first line hc 0.1.17's machine dial sends (captured through a tee'ing `--via`): framed, with its core. */
export const peerHello = (id: string, pad = "") =>
  `{"id":1,"jsonrpc":"2.0","method":"hello","params":{"calls_you":"peerb","core":{"id":"${id}","name":"mac"},"features":["framed"],"framed":true,"generation":1${pad === "" ? "" : `,"pad":"${pad}"`}}}\n`;
/** `machine.add`'s probe: an unframed hello with no core. */
export const PROBE = '{"id":1,"jsonrpc":"2.0","method":"hello","params":{"generation":1}}\n';
/** A framed client's hello (the web client, `doriface-host connect`). */
export const CLIENT = '{"jsonrpc":"2.0","id":0,"method":"hello","params":{"framed":true}}\n';

/** A child link that records every byte the gateway pipes to it. */
export function recordingPipe(inner?: ChildLink) {
  const piped: Uint8Array[] = [];
  const reached = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  const child: ChildLink = {
    exited: inner?.exited ?? exited.promise,
    send: async (bytes) => {
      piped.push(bytes);
      reached.resolve();
      await inner?.send(bytes);
    },
    onData: (handler) => inner?.onData(handler),
    onClose: (handler) => inner?.onClose(handler),
    close: () => (inner === undefined ? exited.resolve() : inner.close()),
  };
  const text = () => new TextDecoder().decode(Buffer.concat(piped));
  return { child, piped, text, reached: reached.promise };
}

export interface GatewaySetup {
  readonly dir: string;
  /** Opens the hc pipe for a session; defaults to a recording pipe with no hc behind it. */
  readonly openPipe?: (() => ChildLink) | undefined;
  /** The store the gateway reads instead of the fixture's own. */
  readonly mesh?: MeshStore | undefined;
}

/** A gateway on a mesh of `founder` (this host) and `member`. */
export function gatewayOn(founder: Machine, member: Machine, setup: GatewaySetup) {
  const fixture = new MeshFixture(setup.dir, founder);
  fixture.admit(founder, member);
  const mesh = setup.mesh ?? fixture.store;
  const devices = new DeviceStore(setup.dir);
  const pipe = recordingPipe();
  let opened = 0;
  const logs: string[] = [];
  const log = (line: string): void => void logs.push(line);
  const deps = { identity: founder.identity, devices, pairing: new PairingStore(setup.dir), mesh, log };
  const gateway = createGateway({
    token: "t".repeat(32),
    hostVersion: "0",
    hcVersion: "0",
    openPipe: () => {
      opened++;
      return setup.openPipe?.() ?? pipe.child;
    },
    log,
    e2ee: { ...deps, lanUrls: [], sessions: new LiveSessions(devices, log, mesh) },
  });
  return { gateway, devices, logs, pipe, opened: () => opened };
}

/** Dials `setup`'s gateway with `key` over a real Noise handshake; `early` rides in message 1. */
export async function dial(
  setup: ReturnType<typeof gatewayOn>,
  key: Machine["identity"]["noise"],
  founder: Machine,
  early?: string,
) {
  const [clientEnd, hostEnd] = memoryLinkPair();
  const wire: E2eeWire = {
    send: (bytes) => hostEnd.send(bytes),
    onData: (listener) => hostEnd.onData(listener),
    onClose: (listener) => hostEnd.onClose(listener),
    close: (code, reason) => hostEnd.close(code, reason),
    flushed: () => Promise.resolve(),
    readWhen() {},
  };
  const served = setup.gateway.serveE2ee(wire, { kind: "lan" });
  const client: SecureLink = await secureLink(clientEnd, {
    role: "initiator",
    hostId: founder.identity.hostId,
    staticKey: rawStaticKey(key),
    remoteStatic: founder.identity.noise.publicKey,
    early: early === undefined ? undefined : encoder.encode(early),
  });
  await served;
  const closed = Promise.withResolvers<void>();
  client.onClose(() => closed.resolve());
  const received: Uint8Array[] = [];
  const answered = Promise.withResolvers<void>();
  client.onData((bytes) => {
    received.push(bytes);
    answered.resolve();
  });
  const send = (text: string): void => client.send(encoder.encode(text));
  return { client, hostEnd, send, received, answered: answered.promise, closed: closed.promise };
}
