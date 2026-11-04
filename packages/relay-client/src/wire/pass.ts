/**
 * Relay passes (contract v1.6). A pass is the relay's MAC over a host identity that passed its uplink challenge; a
 * proof is that pass plus a fresh signature by the host key over one upgrade. A valid proof skips the relay's
 * per-address limit and is charged to the host's key instead.
 */

export const PASS_BYTES = 58;
export const PASS_VERSION = 1;
export const PROOF_VERSION = 1;
export const PROOF_CONTEXT = "doriface-relay-proof-v1";
/** `version || pass || signPub || ts || nonce`: what the proof signature covers after its prefix. */
export const PROOF_BODY_BYTES = 1 + PASS_BYTES + 32 + 8 + 16;
export const PROOF_BYTES = PROOF_BODY_BYTES + 64;
export const PASS_QUERY = ["pass", "1"] as const;
export const PROOF_QUERY = "proof";

export type ProofRole = "host" | "client";

/** A relay-to-host PASS frame's payload: the relay's clock, and a pass unless the relay had none to give. */
export interface PassFrame {
  readonly relayNowMs: number;
  readonly pass?: Uint8Array<ArrayBuffer> | undefined;
}

export interface PassFields {
  readonly kid: number;
  /** Unix seconds. */
  readonly issuedAt: number;
  /** Unix seconds. */
  readonly expiresAt: number;
  readonly hostIdHash: Uint8Array<ArrayBuffer>;
}

/** The PASS payload (8 or 66 bytes), or undefined when it is neither. */
export function decodePassPayload(payload: Uint8Array): PassFrame | undefined {
  if (payload.byteLength !== 8 && payload.byteLength !== 8 + PASS_BYTES) return undefined;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const relayNowMs = Number(view.getBigUint64(0));
  return payload.byteLength === 8 ? { relayNowMs } : { relayNowMs, pass: payload.slice(8) };
}

/** The readable fields of a pass, or undefined for a pass of another length or version. */
export function passFields(pass: Uint8Array): PassFields | undefined {
  if (pass.byteLength !== PASS_BYTES || pass[0] !== PASS_VERSION) return undefined;
  const view = new DataView(pass.buffer, pass.byteOffset, pass.byteLength);
  return {
    kid: view.getUint8(1),
    issuedAt: view.getUint32(2),
    expiresAt: view.getUint32(6),
    hostIdHash: pass.slice(10, 26),
  };
}

const encoder = new TextEncoder();

function concat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

export interface ProofInput {
  readonly pass: Uint8Array;
  readonly signPub: Uint8Array;
  readonly relayOrigin: string;
  readonly role: ProofRole;
  /** The hostId in the upgrade's path. */
  readonly target: string;
  /** The relay's clock, in ms. */
  readonly ts: number;
  readonly nonce: Uint8Array;
}

/** `"doriface-relay-proof-v1" || relayOrigin || 0 || role || 0 || target || 0 || body`: the bytes a host signs. */
export function proofMessage(input: ProofInput): { readonly body: Uint8Array; readonly message: Uint8Array } {
  const ts = new Uint8Array(8);
  new DataView(ts.buffer).setBigUint64(0, BigInt(Math.floor(input.ts)));
  const body = concat(new Uint8Array([PROOF_VERSION]), input.pass, input.signPub, ts, input.nonce);
  const zero = new Uint8Array([0]);
  const message = concat(
    encoder.encode(PROOF_CONTEXT + input.relayOrigin),
    zero,
    encoder.encode(input.role),
    zero,
    encoder.encode(input.target),
    zero,
    body,
  );
  return { body, message };
}

/** The proof bytes: the body followed by the host's signature over {@link proofMessage}. */
export function encodeProof(body: Uint8Array, signature: Uint8Array): Uint8Array<ArrayBuffer> {
  return concat(body, signature);
}
