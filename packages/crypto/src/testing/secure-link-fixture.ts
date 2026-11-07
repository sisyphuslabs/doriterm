import { generateHostIdentity, generateX25519, type KeyPair } from "../identity.ts";
import { SecureLinkError } from "../link.ts";
import type { PairingSecret } from "../client-flight.ts";
import { SessionKind } from "../kinds.ts";
import { createPairingOffer } from "../pairing.ts";
import { type Authorization, type ClientHello, secureLink } from "../secure-link.ts";
import type { SecureLink } from "../secured-link.ts";
import { rawStaticKey, type StaticKey } from "../static-key.ts";
import { memoryLinkPair, type MemoryEnd } from "./memory-link.ts";

export const host = generateHostIdentity();
export const device = generateX25519();
export const offer = createPairingOffer();
export const codePairing = (name: string, code = offer.code): PairingSecret => ({ mode: "code", code, name });
export const linkPairing = (name: string, linkSecret = offer.linkSecret): PairingSecret => ({
  mode: "link",
  linkSecret,
  name,
});
export const hellos: ClientHello[] = [];

/** The host's default decision: every session key is accepted, and a pairing finishes with the offer's secret. */
export function acceptAll(hello: ClientHello): Authorization {
  hellos.push(hello);
  if (hello.kind === SessionKind.PairCode) return { accept: true, secret: { mode: "code", code: offer.code } };
  if (hello.kind === SessionKind.PairLink)
    return { accept: true, secret: { mode: "link", linkSecret: offer.linkSecret } };
  return { accept: true };
}

export interface Setup {
  readonly pairing?: PairingSecret;
  readonly authorize?: (hello: ClientHello) => Authorization;
  readonly clientKey?: KeyPair | StaticKey;
  readonly early?: Uint8Array;
  readonly lanUrls?: readonly string[];
  readonly rekey?: readonly [number, number];
  /** Rewrites the client's first message (message 1) in flight. */
  readonly tamperHello?: (bytes: Uint8Array) => Uint8Array;
  readonly synchronous?: boolean;
  /** The responder's early-answer hook (#1271). */
  readonly answerEarly?: (early: Uint8Array, session: SecureLink) => void;
  /** Both ends' handshake deadline. */
  readonly timeoutMs?: number;
}

const toStatic = (key: KeyPair | StaticKey): StaticKey => ("dh" in key ? key : rawStaticKey(key));

/** Rewrites the next message the end sends. */
export function tamperNext(end: MemoryEnd, rewrite: (bytes: Uint8Array) => readonly Uint8Array[]): void {
  end.tap = (bytes) => {
    end.tap = undefined;
    return rewrite(bytes);
  };
}

export function connect(setup: Setup = {}) {
  const [clientEnd, hostEnd] = memoryLinkPair(setup.synchronous);
  const tamperHello = setup.tamperHello;
  if (tamperHello !== undefined) tamperNext(clientEnd, (bytes) => [tamperHello(bytes)]);
  const responder = secureLink(hostEnd, {
    role: "responder",
    hostId: host.hostId,
    staticKey: rawStaticKey(host.noise),
    rekeyInterval: setup.rekey?.[1],
    lanUrls: setup.lanUrls,
    authorize: setup.authorize ?? acceptAll,
    answerEarly: setup.answerEarly,
    timeoutMs: setup.timeoutMs,
  });
  const initiator = secureLink(clientEnd, {
    role: "initiator",
    hostId: host.hostId,
    staticKey: toStatic(setup.clientKey ?? device),
    remoteStatic: host.noise.publicKey,
    pairing: setup.pairing,
    early: setup.early,
    rekeyInterval: setup.rekey?.[0],
    timeoutMs: setup.timeoutMs,
  });
  return { clientEnd, hostEnd, initiator, responder };
}

export async function established(setup: Setup = {}) {
  const pair = connect(setup);
  const [client, server] = await Promise.all([pair.initiator, pair.responder]);
  return { ...pair, client, server };
}

export const collect = (link: SecureLink): Uint8Array[] => {
  const chunks: Uint8Array[] = [];
  link.onData((chunk) => chunks.push(chunk));
  return chunks;
};

export async function settledError(promise: Promise<unknown>): Promise<SecureLinkError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof SecureLinkError)) throw new Error(`expected a SecureLinkError, got ${String(error)}`);
  return error;
}

export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
