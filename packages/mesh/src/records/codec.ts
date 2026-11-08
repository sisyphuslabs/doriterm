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
  MEMBER_KINDS,
  type MemberKind,
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
/**
 * A signed record's hash and parsed body, computed once per record object: a `Signed` is immutable, and a merge asks
 * for both of every stored record many times (heads, own counters, the fold, the door's index), each a SHA-256 or a
 * JSON parse of the whole body.
 */
const hashes = new WeakMap<Signed, string>();
const bodies = new WeakMap<Signed, RecordBody | null>();

export function hashOf(record: Signed): string {
  const known = hashes.get(record);
  if (known !== undefined) return known;
  const hash = base64urlEncode(sha256(encoder.encode(record.body)));
  hashes.set(record, hash);
  return hash;
}
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
  if (!isSigned(record)) return undefined;
  const known = bodies.get(record);
  if (known !== undefined) return known ?? undefined;
  const json = fitsBody(record.body) ? parseIJsonObject(record.body) : undefined;
  const body = json === undefined ? undefined : recordBodyOf(json);
  bodies.set(record, body ?? null);
  return body;
}

function cardBodyOf(body: JsonObject): CardBody | undefined {
  const { v, kind, mesh, inviter, nonce, hostId, signPub, noisePub, devicePub, name, hcId } = body;
  if (v !== 1 && v !== 2) return undefined;
  // A version 1 card can only mean a machine: that is the only kind the format ever carried, so reading it as anything
  // else would reinterpret history. Version 2 must say which kind it is, and an unknown kind is refused rather than
  // guessed (design of #942).
  const memberKind: MemberKind | undefined = v === 1 ? "machine" : MEMBER_KINDS.find((known) => known === kind);
  if (memberKind === undefined) return undefined;
  if (!isKey(signPub) || !isKey(noisePub) || (devicePub !== undefined && !isKey(devicePub))) {
    return undefined;
  }
  // A client is reached by its session key and has no Noise line of its own to dial from, so a client card without a
  // devicePub would name a member nothing can reach (design of #942). A machine may carry one or not.
  if (memberKind === "client" && devicePub === undefined) return undefined;
  if (typeof mesh !== "string" || typeof inviter !== "string" || typeof nonce !== "string") return undefined;
  if (!decodes(nonce, 16) || typeof hostId !== "string" || typeof hcId !== "string") return undefined;
  if (typeof name !== "string" || !checkName(name)) return undefined;
  if (hostIdOf(base64urlDecode(signPub)) !== hostId) return undefined;
  return {
    v,
    kind: memberKind,
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

/**
 * Cards already checked, by their signature and the hash of their body, with what the check found: a stored card is
 * read again by every write (the door's index, the authorize index, `recordsOf`), and its ed25519 check is the cost
 * (#94). The result depends on those bytes alone, so it holds for the process. Oldest first out past the bound.
 */
const checkedCards = new Map<string, CardBody | null>();
const MAX_CHECKED_CARDS = 4096;

/** The card's body when it is well formed and its signature verifies under its own signPub; otherwise undefined. */
export function verifyCard(card: Signed): CardBody | undefined {
  if (!isSigned(card) || !fitsBody(card.body)) return undefined;
  const key = `${card.sig}.${hashOf(card)}`;
  const known = checkedCards.get(key);
  if (known !== undefined) return known ?? undefined;
  const raw = parseIJsonObject(card.body);
  const body = raw === undefined ? undefined : cardBodyOf(raw);
  const checked = body !== undefined && verifies("card", card, body.signPub) ? body : undefined;
  if (checkedCards.size >= MAX_CHECKED_CARDS) checkedCards.delete(checkedCards.keys().next().value ?? "");
  checkedCards.set(key, checked ?? null);
  return checked;
}

export function cardOf(body: RecordBody): Signed | undefined {
  const subject = body.subject;
  return subject !== undefined && "card" in subject ? subject.card : undefined;
}
