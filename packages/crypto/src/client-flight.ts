import { concatBytes } from "./encoding.ts";
import { cpaceInitiate } from "./cpace.ts";
import { prologueFor } from "./identity.ts";
import { checkReplySize, SessionKind, SID_LENGTH } from "./kinds.ts";
import { Handshake } from "./noise/handshake.ts";
import { codePairingInputs, codePairingPsk, linkPairingPsk } from "./pairing-keys.ts";
import { decodeReply, encodePairingHello, encodeSessionHello, PayloadError, type Stream } from "./payloads.ts";
import type { StaticKey } from "./static-key.ts";

/** How a device pairs: with the typed code (CPace) or with the link secret from the pairing URL. */
export type PairingSecret =
  | { readonly mode: "code"; readonly code: string; readonly name: string }
  | { readonly mode: "link"; readonly linkSecret: Uint8Array; readonly name: string };

export interface ClientFlightOptions {
  readonly hostId: string;
  readonly staticKey: StaticKey;
  /** The host's Noise static public key. */
  readonly remoteStatic: Uint8Array;
  /** Present to pair; absent for every session after pairing. */
  readonly pairing?: PairingSecret | undefined;
  /** Session only: the first stream bytes (at most 4096), sent inside message 1. */
  readonly early?: Uint8Array | undefined;
  /** What the session carries (absent: the hc stream; a pairing takes only `"mesh"`, a machine join). */
  readonly stream?: Stream | undefined;
}

/** Fixed randomness, for tests only (not exported from the package). */
export interface ClientFlightTestOptions {
  readonly ephemeralSecret?: Uint8Array;
  readonly cpaceScalar?: bigint;
  readonly sid?: Uint8Array;
}

export interface ClientFlight {
  readonly kind: SessionKind;
  /** The first message to send: the kind byte, the CPace sid and share for a typed code, and Noise message 1. */
  readonly first: Uint8Array;
  /** Reads the host's first message; returns the finished handshake and the host's LAN URLs. Throws on failure. */
  reply(bytes: Uint8Array): Promise<{ readonly handshake: Handshake; readonly lanUrls: readonly string[] }>;
}

/** Builds the client's first message for its kind (contract v1.3 "Session kinds"). */
export async function clientFlight(
  opts: ClientFlightOptions,
  test: ClientFlightTestOptions = {},
): Promise<ClientFlight> {
  const pairing = opts.pairing;
  const base = { role: "initiator", staticKey: opts.staticKey, remoteStatic: opts.remoteStatic } as const;
  const ephemeralSecret = test.ephemeralSecret;
  if (pairing === undefined) {
    const prologue = prologueFor(opts.hostId, SessionKind.Session);
    const handshake = new Handshake({ ...base, pattern: "IK", prologue, ephemeralSecret });
    const first = concatBytes(
      Uint8Array.of(SessionKind.Session),
      await handshake.writeMessage(encodeSessionHello(opts.early, opts.stream)),
    );
    return finishing(SessionKind.Session, handshake, first);
  }
  if (opts.stream === "hc" || opts.stream === "push" || opts.stream === "roster") {
    throw new PayloadError(`stream "${opts.stream}" is not valid on a pairing`);
  }
  const hello = encodePairingHello(pairing.name, opts.stream);
  if (pairing.mode === "link") {
    const prologue = prologueFor(opts.hostId, SessionKind.PairLink);
    const psk = linkPairingPsk(pairing.linkSecret, opts.hostId, opts.remoteStatic);
    const handshake = new Handshake({ ...base, pattern: "IKpsk2", prologue, psk, ephemeralSecret });
    const first = concatBytes(Uint8Array.of(SessionKind.PairLink), await handshake.writeMessage(hello));
    return finishing(SessionKind.PairLink, handshake, first);
  }
  const sid = test.sid ?? crypto.getRandomValues(new Uint8Array(SID_LENGTH));
  const cpace = cpaceInitiate(
    { ...codePairingInputs(pairing.code, opts.hostId, opts.remoteStatic), sid },
    test.cpaceScalar === undefined ? {} : { scalar: test.cpaceScalar },
  );
  const prologue = prologueFor(opts.hostId, SessionKind.PairCode, concatBytes(sid, cpace.share));
  const handshake = new Handshake({ ...base, pattern: "IKpsk2", prologue, ephemeralSecret });
  const msg1 = await handshake.writeMessage(hello);
  const first = concatBytes(Uint8Array.of(SessionKind.PairCode), sid, cpace.share, msg1);
  return finishing(SessionKind.PairCode, handshake, first, (yb) => handshake.setPsk(codePairingPsk(cpace.finish(yb))));
}

/** The reply step: check the size, split off `Yb` for a typed code and set the psk from it, then read message 2. */
function finishing(
  kind: SessionKind,
  handshake: Handshake,
  first: Uint8Array,
  withShare?: (yb: Uint8Array) => void,
): ClientFlight {
  return {
    kind,
    first,
    async reply(bytes) {
      checkReplySize(kind, bytes);
      let message2 = bytes;
      if (withShare !== undefined) {
        withShare(bytes.subarray(0, 32));
        message2 = bytes.subarray(32);
      }
      const lanUrls = decodeReply(await handshake.readMessage(message2));
      return { handshake, lanUrls };
    },
  };
}
