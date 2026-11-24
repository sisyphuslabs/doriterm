import { base64urlDecode, base64urlEncode } from "@doriface/crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { KeyProtection, MemberSigner } from "./context.ts";

/** The exact body bytes (as UTF-8 text) a member signed, and the base64url Ed25519 signature over them. */
export interface SignedRecord {
  readonly body: string;
  readonly sig: string;
}

/** "This member's vault key is this age recipient", signed by the member's mesh key. */
export interface DeviceBody {
  readonly v: 1;
  readonly type: "vault-device";
  readonly mesh: string;
  readonly signPub: string;
  readonly recipient: string;
  readonly protection: KeyProtection;
  readonly at: string;
}

/** A tier generation's public keys, signed by the member that created it. */
export interface TierBody {
  readonly v: 1;
  readonly type: "vault-tier";
  readonly mesh: string;
  readonly tier: "mesh";
  readonly gen: number;
  readonly recipient: string;
  readonly signPublic: string;
  readonly by: string;
  readonly at: string;
}

const encoder = new TextEncoder();

export async function signRecord(body: DeviceBody | TierBody, signer: MemberSigner): Promise<SignedRecord> {
  const text = JSON.stringify(body);
  return { body: text, sig: base64urlEncode(await signer.sign(encoder.encode(text))) };
}

/** A stable id for a record: the first 16 bytes of SHA-256 over its body, as hex. */
export const recordId = (record: SignedRecord): string =>
  bytesToHex(sha256(encoder.encode(record.body)).subarray(0, 16));

function verified(record: SignedRecord, signPub: string): boolean {
  try {
    return ed25519.verify(base64urlDecode(record.sig), encoder.encode(record.body), base64urlDecode(signPub));
  } catch (cause) {
    if (cause instanceof Error) return false;
    throw cause;
  }
}

function parseBody(record: SignedRecord): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(record.body);
  } catch (cause) {
    if (cause instanceof SyntaxError) return undefined;
    throw cause;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : undefined;
}

const PROTECTIONS: readonly KeyProtection[] = ["unprotected", "non-extractable", "os-keystore"];
const isProtection = (value: unknown): value is KeyProtection => PROTECTIONS.some((known) => known === value);
const text = (value: unknown): value is string => typeof value === "string" && value !== "";

/** The device body, when it is well formed, for `mesh`, and signed by the member it names. */
export function readDevice(record: SignedRecord, mesh: string): DeviceBody | undefined {
  const b = parseBody(record);
  if (b === undefined || b["v"] !== 1 || b["type"] !== "vault-device" || b["mesh"] !== mesh) return undefined;
  const { signPub, recipient, protection, at } = b;
  if (!text(signPub) || !text(recipient) || !recipient.startsWith("age1") || !isProtection(protection) || !text(at))
    return undefined;
  if (!verified(record, signPub)) return undefined;
  return { v: 1, type: "vault-device", mesh, signPub, recipient, protection, at };
}

/** The tier body, when it is well formed, for `mesh`, and signed by the member in its `by`. */
export function readTier(record: SignedRecord, mesh: string): TierBody | undefined {
  const b = parseBody(record);
  if (b === undefined || b["v"] !== 1 || b["type"] !== "vault-tier" || b["mesh"] !== mesh || b["tier"] !== "mesh")
    return undefined;
  const { gen, recipient, signPublic, by, at } = b;
  if (typeof gen !== "number" || !Number.isSafeInteger(gen) || gen < 1) return undefined;
  if (!text(recipient) || !recipient.startsWith("age1") || !text(signPublic) || !text(by) || !text(at))
    return undefined;
  if (!verified(record, by)) return undefined;
  return { v: 1, type: "vault-tier", mesh, tier: "mesh", gen, recipient, signPublic, by, at };
}

/** The `at` of a record's body, for merge order only (never trusted for anything else). */
export const recordAt = (record: SignedRecord): string => {
  const at = parseBody(record)?.["at"];
  return typeof at === "string" ? at : "";
};

/** Whether the record's signature verifies for the signPub it is filed under (merge keeps a forged copy out). */
export const signedBy = (record: SignedRecord, signPub: string): boolean => verified(record, signPub);
