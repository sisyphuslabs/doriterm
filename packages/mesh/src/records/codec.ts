import { base32Encode, base64urlDecode, base64urlEncode, concatBytes, hostIdOf } from "@doriface/crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { checkName } from "../names.ts";
import { isObject, type JsonObject, parseIJsonObject } from "./json.ts";
import {
  type CardBody,
  MAX_BODY_BYTES,
  MAX_PREV,
  MAX_REVOKE_SUBJECTS,
  RECORD_TYPES,
  type RecordBody,
  type RecordType,
  REVOKE_REASONS,
  type Signed,
  type Subject,
} from "./types.ts";

const RECORD_PREFIX = "doriface-mesh/1";
const CARD_PREFIX = "doriface-mesh/1 card";
const encoder = new TextEncoder();

const digest = (prefix: string, body: string): Uint8Array =>
  concatBytes(encoder.encode(prefix), sha256(encoder.encode(body)));

function signWith(prefix: string, body: string, secret: Uint8Array): Signed {
  return { body, sig: base64urlEncode(ed25519.sign(digest(prefix, body), secret)) };
}

/**
 * The one spelling of `bytes` bytes in unpadded base64url: exactly ceil(4 * bytes / 3) characters of the alphabet
 * (22, 43 or 86), with zero trailing bits, so a peer cannot make the decoder throw or name one key two ways.
 */
function decodes(value: unknown, bytes: 16 | 32 | 64): value is string {
  if (typeof value !== "string" || value.length !== Math.ceil((4 * bytes) / 3)) return false;
  return /^[A-Za-z0-9_-]*$/.test(value) && base64urlEncode(base64urlDecode(value)) === value;
}

export const isKey = (value: unknown): value is string => decodes(value, 32);
const isHash = isKey;
export const isSignature = (value: unknown): value is string => decodes(value, 64);

/** At most MAX_BODY_BYTES of UTF-8 (a UTF-16 length over the limit is over it in UTF-8 too, so it is never encoded). */
export const fitsBody = (text: string): boolean =>
  text.length <= MAX_BODY_BYTES && encoder.encode(text).byteLength <= MAX_BODY_BYTES;

export function verifies(prefix: "record" | "card", signed: Signed, signPub: string): boolean {
  if (!isKey(signPub) || !isSignature(signed.sig)) return false;
  const message = digest(prefix === "record" ? RECORD_PREFIX : CARD_PREFIX, signed.body);
  return ed25519.verify(base64urlDecode(signed.sig), message, base64urlDecode(signPub));
}

export const encodeBody = (body: RecordBody | CardBody): string => JSON.stringify(body);
export const hashOf = (record: Signed): string => base64urlEncode(sha256(encoder.encode(record.body)));
export const meshIdOf = (found: Signed): string => base32Encode(sha256(encoder.encode(found.body)).subarray(0, 16));

export const signRecord = (body: RecordBody, signSecret: Uint8Array): Signed =>
  signWith(RECORD_PREFIX, encodeBody(body), signSecret);
export const signCard = (body: CardBody, signSecret: Uint8Array): Signed =>
  signWith(CARD_PREFIX, encodeBody(body), signSecret);

export const isSigned = (value: unknown): value is Signed =>
  isObject(value) && typeof value["body"] === "string" && typeof value["sig"] === "string";
const isRecordType = (value: unknown): value is RecordType => RECORD_TYPES.some((type) => type === value);
const distinct = (items: readonly string[]): boolean => new Set(items).size === items.length;
const strings = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;

function subjectOf(type: RecordType, raw: unknown): Subject | undefined | false {
  if (type === "ack") return raw === undefined ? undefined : false;
  if (!isObject(raw)) return false;
  if (type === "found" || type === "admit" || type === "rekey") {
    return isSigned(raw["card"]) ? { card: raw["card"] } : false;
  }
  if (type === "revoke") {
    const keys = strings(raw["signPubs"]);
    const reason = REVOKE_REASONS.find((r) => r === raw["reason"]);
    const ok = keys !== undefined && keys.length >= 1 && keys.length <= MAX_REVOKE_SUBJECTS;
    return ok && reason !== undefined && distinct(keys) && keys.every(isKey) ? { signPubs: keys, reason } : false;
  }
  const { signPub, name } = raw;
  return isKey(signPub) && typeof name === "string" && checkName(name) ? { signPub, name } : false;
}

function recordBodyOf(body: JsonObject): RecordBody | undefined {
  const { v, mesh, type, by, n, prev, at } = body;
  if (v !== 2 || typeof mesh !== "string" || !isRecordType(type) || !isKey(by)) return undefined;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || (at !== undefined && typeof at !== "string")) {
    return undefined;
  }
  const parents = strings(prev);
  if (parents === undefined || !distinct(parents) || !parents.every(isHash)) return undefined;
  const founding = type === "found";
  if (founding ? parents.length !== 0 || n !== 1 : parents.length < 1 || parents.length > MAX_PREV) return undefined;
  const subject = subjectOf(type, body["subject"]);
  if (subject === false) return undefined;
  return {
    v: 2,
    mesh,
    type,
    by,
    n,
    prev: parents,
    ...(subject === undefined ? {} : { subject }),
    ...(at === undefined ? {} : { at }),
  };
}

/** The record's body when it is a well-formed v2 record body (shape only: no signature or card check). */
export function parseRecord(record: Signed): RecordBody | undefined {
  if (!isSigned(record) || !fitsBody(record.body)) return undefined;
  const body = parseIJsonObject(record.body);
  return body === undefined ? undefined : recordBodyOf(body);
}

function cardBodyOf(body: JsonObject): CardBody | undefined {
  const { v, mesh, inviter, nonce, hostId, signPub, noisePub, devicePub, name, hcId } = body;
  if (v !== 1 || !isKey(signPub) || !isKey(noisePub) || (devicePub !== undefined && !isKey(devicePub))) {
    return undefined;
  }
  if (typeof mesh !== "string" || typeof inviter !== "string" || typeof nonce !== "string") return undefined;
  if (!decodes(nonce, 16) || typeof hostId !== "string" || typeof hcId !== "string") return undefined;
  if (typeof name !== "string" || !checkName(name)) return undefined;
  if (hostIdOf(base64urlDecode(signPub)) !== hostId) return undefined;
  return {
    v: 1,
    mesh,
    inviter,
    nonce,
    hostId,
    signPub,
    noisePub,
    ...(devicePub === undefined ? {} : { devicePub }),
    name,
    hcId,
  };
}

/** The card's body when it is well formed and its signature verifies under its own signPub; otherwise undefined. */
export function verifyCard(card: Signed): CardBody | undefined {
  if (!isSigned(card) || !fitsBody(card.body)) return undefined;
  const raw = parseIJsonObject(card.body);
  const body = raw === undefined ? undefined : cardBodyOf(raw);
  return body !== undefined && verifies("card", card, body.signPub) ? body : undefined;
}

export function cardOf(body: RecordBody): Signed | undefined {
  const subject = body.subject;
  return subject !== undefined && "card" in subject ? subject.card : undefined;
}
