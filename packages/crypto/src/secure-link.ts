import { type ClientFlightTestOptions, clientFlight, type PairingSecret } from "./client-flight.ts";
import {
  answerClientFlight,
  type HostFlightTestOptions,
  type HostPairingSecret,
  readClientFlight,
} from "./host-flight.ts";
import { SessionKind } from "./kinds.ts";
import { type ByteLink, CloseCode, closeCodeOf, SecureLinkError } from "./link.ts";
import type { Handshake } from "./noise/handshake.ts";
import { PayloadError, type Stream } from "./payloads.ts";
import { MAX_HELD_BYTES, type SecureLink, SecuredLink, type SecureSession, type SessionInfo } from "./secured-link.ts";
import type { StaticKey } from "./static-key.ts";
import { REKEY_INTERVAL, Transport } from "./transport.ts";

export const HANDSHAKE_TIMEOUT_MS = 10_000;
const EMPTY = new Uint8Array(0);

interface CommonOptions {
  readonly hostId: string;
  /** The local static key (raw bytes for the host, possibly a non-extractable WebCrypto key on the web). */
  readonly staticKey: StaticKey;
  /** Closes with 4408 when the handshake has not finished in time; default {@link HANDSHAKE_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined;
  /** Messages per direction between rekeys; the contract's 2^20 unless a test needs a short cycle. */
  readonly rekeyInterval?: number | undefined;
}

export interface InitiatorOptions extends CommonOptions {
  readonly role: "initiator";
  /** The host's Noise static public key. */
  readonly remoteStatic: Uint8Array;
  /** Present to pair (by typed code or by link secret); absent for every session after pairing. */
  readonly pairing?: PairingSecret | undefined;
  /** Session only: the first stream bytes (at most 4096), sent inside message 1. */
  readonly early?: Uint8Array | undefined;
  /** What the session carries: absent or `"hc"` (the hc stream), `"mesh"` or `"push"`; a pairing takes only `"mesh"`. */
  readonly stream?: Stream | undefined;
  /** For tests only: fixed randomness. */
  readonly testRandomness?: ClientFlightTestOptions | undefined;
}

export interface ClientHello {
  readonly kind: SessionKind;
  readonly remoteStatic: Uint8Array;
  /** The device name of a pairing hello. */
  readonly name: string | undefined;
  /** The `stream` member of message 1. */
  readonly stream: Stream | undefined;
}

/**
 * The host's decision after message 1, made before anything is answered. A session accepts or refuses the device
 * key; a pairing accepts by naming the offer's secret for its kind. A refusal closes with `closeCode` (default 4401).
 */
export type Authorization =
  | { readonly accept: true; readonly secret?: HostPairingSecret | undefined }
  | { readonly accept: false; readonly closeCode?: number | undefined; readonly reason?: string | undefined };

export interface ResponderOptions extends CommonOptions {
  readonly role: "responder";
  /** Decides on the client after message 1; a refusal closes with 4401. */
  readonly authorize: (hello: ClientHello) => Authorization;
  /** IP-literal `ws://…/v1/e2ee` URLs for message 2 (at most 8). */
  readonly lanUrls?: readonly string[] | undefined;
  /**
   * Session only, once message 2 has gone out: the host may answer these IK early bytes before the client confirms the
   * keys, by sealing its answer with `session.send` (#1271). `session` is not established yet: only `send` may be called
   * on it, never `onData`. The early bytes are still held for the session's first listener, and the session still
   * resolves only on the client's confirmation, within the same absolute handshake deadline.
   */
  readonly answerEarly?: ((early: Uint8Array, session: SecureLink) => void) | undefined;
  /** For tests only: fixed randomness. */
  readonly testRandomness?: HostFlightTestOptions | undefined;
}

export type SecureLinkOptions = InitiatorOptions | ResponderOptions;

const failure = (code: number, message: string, cause?: unknown): SecureLinkError =>
  new SecureLinkError(code, message, cause === undefined ? undefined : { cause });

/**
 * Runs the Noise handshake over `link` and resolves with the encrypted link. Messages are processed strictly in order
 * even though the static DH is async. The initiator's first transport record (empty) confirms the keys, so the
 * responder resolves, and releases IK early bytes, only once the peer provably holds them: a replayed message 1
 * never gets that far. Any failure closes `link` with its code (4400 crypto, 4401 refused, 4408 timeout) and rejects
 * with a {@link SecureLinkError}.
 */
export function secureLink(link: ByteLink, options: SecureLinkOptions): Promise<SecureSession> {
  const settled = Promise.withResolvers<SecureSession>();
  const rekeyInterval = options.rekeyInterval ?? REKEY_INTERVAL;
  const inbox: Uint8Array[] = [];
  let inboxBytes = 0;
  let session: SecuredLink | undefined;
  let done = false;
  let draining = false;
  let step: ((bytes: Uint8Array) => Promise<void>) | undefined;

  const fail = (error: SecureLinkError): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    inbox.length = 0;
    if (error.code !== undefined) link.close(error.code, error.message);
    settled.reject(error);
  };
  const guarded = (fn: (bytes: Uint8Array) => Promise<void>) => async (bytes: Uint8Array) => {
    try {
      await fn(bytes);
    } catch (error) {
      if (error instanceof SecureLinkError) fail(error);
      else if (error instanceof PayloadError) fail(failure(CloseCode.CryptoFailure, error.message, error));
      else fail(failure(CloseCode.CryptoFailure, "handshake failed", error));
    }
  };
  const establish = (
    kind: SessionKind,
    handshake: Handshake,
    info: Pick<SessionInfo, "peerName" | "lanUrls" | "stream">,
  ): SecuredLink => {
    const { send, receive, handshakeHash, remoteStatic } = handshake.finish(rekeyInterval);
    return new SecuredLink(link, new Transport(send, receive), {
      kind,
      remoteStatic,
      handshakeHash,
      ...info,
    });
  };
  /** Installs the session before anything else is sent, so a peer that answers synchronously reaches it. */
  const resolve = (secured: SecuredLink): void => {
    done = true;
    clearTimeout(timer);
    session = secured;
    for (const bytes of inbox.splice(0)) secured.receive(bytes);
    settled.resolve(secured);
  };
  const drain = async (): Promise<void> => {
    const bytes = inbox.shift();
    if (bytes === undefined || done || step === undefined) {
      draining = false;
      return;
    }
    inboxBytes -= bytes.byteLength;
    await step(bytes);
    return drain();
  };

  const timer = setTimeout(
    () => fail(failure(CloseCode.IdleTimeout, "handshake timed out")),
    options.timeoutMs ?? HANDSHAKE_TIMEOUT_MS,
  );
  link.onData((bytes) => {
    if (session !== undefined) return session.receive(bytes);
    if (done) return;
    inbox.push(bytes);
    inboxBytes += bytes.byteLength;
    if (inboxBytes > MAX_HELD_BYTES) return fail(failure(CloseCode.IdleTimeout, "too much data during the handshake"));
    if (draining) return;
    draining = true;
    void drain();
  });
  link.onClose((error) => {
    // The session judges the close itself: a link it has since left is a former one, and a dropped one may detach it.
    if (session !== undefined) session.linkClosed(error, link);
    else fail(failure(closeCodeOf(error) ?? CloseCode.CryptoFailure, "link closed during the handshake", error));
  });

  if (options.role === "initiator") runInitiator(options);
  else runResponder(options);
  return settled.promise;

  /** Setup runs inside the failure path too, so a bad code, secret, name or early payload rejects instead of throwing. */
  function runInitiator(opts: InitiatorOptions): void {
    const start = guarded(async () => {
      const flight = await clientFlight(opts, opts.testRandomness);
      step = guarded(async (bytes) => {
        const { handshake, lanUrls } = await flight.reply(bytes);
        const secured = establish(flight.kind, handshake, { peerName: undefined, lanUrls, stream: opts.stream });
        resolve(secured);
        secured.send(EMPTY);
      });
      link.send(flight.first);
    });
    void start(EMPTY);
  }

  function runResponder(opts: ResponderOptions): void {
    let pending: SecuredLink | undefined;
    const confirm = guarded(async (record) => {
      const secured = pending;
      if (secured === undefined) return;
      secured.receive(record);
      if (secured.closed) throw failure(CloseCode.CryptoFailure, "key confirmation failed");
      resolve(secured);
    });
    step = guarded(async (bytes) => {
      const flight = await readClientFlight(bytes, opts.hostId, opts.staticKey, opts.testRandomness);
      const { message, handshake, hello, remoteStatic } = flight;
      const name = hello.kind === "pairing" ? hello.name : undefined;
      const verdict = opts.authorize({ kind: message.kind, remoteStatic, name, stream: hello.stream });
      if (!verdict.accept) throw failure(verdict.closeCode ?? CloseCode.UnknownDevice, verdict.reason ?? "refused");
      if (message.kind !== SessionKind.Session && verdict.secret === undefined) {
        throw failure(CloseCode.UnknownDevice, "no pairing is pending");
      }
      const lanUrls = opts.lanUrls ?? [];
      const reply = await answerClientFlight(
        flight,
        opts.hostId,
        opts.staticKey,
        verdict.secret,
        lanUrls,
        opts.testRandomness,
      );
      pending = establish(message.kind, handshake, { peerName: name, lanUrls: [], stream: hello.stream });
      if (hello.kind === "session") pending.hold(hello.early);
      step = confirm;
      link.send(reply);
      if (hello.kind === "session" && hello.early.byteLength > 0) opts.answerEarly?.(hello.early, pending);
    });
  }
}
