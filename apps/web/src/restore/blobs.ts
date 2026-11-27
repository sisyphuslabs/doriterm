import { base64urlDecode, base64urlEncode, concatBytes } from "@doriface/crypto";
import { locatorKey, type RestoreEpoch, u64, wrappingKey } from "./keys.ts";

const IV_BYTES = 12;
const TAG_BYTES = 16;
const CARD_BYTES = 32;
const BUCKETS = [4096, 16384, 65536] as const;
const MAX_LOCATOR = 1024;
const HOST_ID = /^[a-z2-7]{26}$/;
const utf8 = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface RestoreHolder {
  readonly hostId: string;
  readonly hostKey: string;
}

export interface RestoreLocator extends RestoreEpoch {
  readonly v: 1;
  readonly relayUrl: string;
  readonly holders: readonly RestoreHolder[];
}

export interface BlobBinding extends RestoreEpoch {
  readonly version: number;
  readonly meshId: string;
  readonly hostId: string;
}

async function seal(
  key: CryptoKey,
  bytes: Uint8Array<ArrayBuffer>,
  aad?: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  return concatBytes(iv, new Uint8Array(await crypto.subtle.encrypt(options(iv, aad), key, bytes)));
}

function options(iv: Uint8Array<ArrayBuffer>, aad?: Uint8Array<ArrayBuffer>): AesGcmParams {
  return { name: "AES-GCM", iv, ...(aad === undefined ? {} : { additionalData: aad }) };
}

async function open(key: CryptoKey, blob: Uint8Array, aad?: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = Uint8Array.from(blob);
  return new Uint8Array(
    await crypto.subtle.decrypt(options(bytes.subarray(0, IV_BYTES), aad), key, bytes.subarray(IV_BYTES)),
  );
}

function bindingBytes(binding: BlobBinding): Uint8Array<ArrayBuffer> {
  if (!HOST_ID.test(binding.meshId) || !HOST_ID.test(binding.hostId)) throw new Error("invalid restore binding");
  return Uint8Array.from(
    concatBytes(u64(binding.version), u64(binding.epoch), utf8.encode(binding.meshId), utf8.encode(binding.hostId)),
  );
}

/** Fixed 32-byte Ed25519 seed followed by padding. The format has no slot for a device or vault key. */
export async function wrapCard(p0: Uint8Array, binding: BlobBinding, card: Uint8Array): Promise<Uint8Array> {
  if (card.byteLength !== CARD_BYTES) throw new RangeError("not an Ed25519 card seed");
  const bytes = new Uint8Array(BUCKETS[0] - IV_BYTES - TAG_BYTES);
  bytes.set(card);
  try {
    return await seal(await wrappingKey(p0, binding), bytes, bindingBytes(binding));
  } finally {
    bytes.fill(0);
  }
}

export async function unwrapCard(p0: Uint8Array, binding: BlobBinding, blob: Uint8Array): Promise<Uint8Array> {
  if (!BUCKETS.some((size) => size === blob.byteLength)) throw new RangeError("invalid restore envelope size");
  const payload = await open(await wrappingKey(p0, binding), blob, bindingBytes(binding));
  try {
    if (payload.subarray(CARD_BYTES).some((byte) => byte !== 0)) throw new Error("invalid restore envelope padding");
    return payload.slice(0, CARD_BYTES);
  } finally {
    payload.fill(0);
  }
}

export async function sealLocator(p0: Uint8Array, locator: RestoreLocator): Promise<Uint8Array> {
  const { relayUrl, epoch, r_e, holders } = locator;
  const bytes = utf8.encode(JSON.stringify({ v: 1, relayUrl, epoch, r_e: base64urlEncode(r_e), holders }));
  if (bytes.byteLength + IV_BYTES + TAG_BYTES > MAX_LOCATOR) throw new RangeError("restore locator does not fit");
  const valid = parseLocator(JSON.parse(decoder.decode(bytes)));
  if (valid === undefined) throw new Error("invalid restore locator");
  return seal(await locatorKey(p0), bytes);
}

export async function openLocator(p0: Uint8Array, blob: Uint8Array): Promise<RestoreLocator> {
  if (blob.byteLength > MAX_LOCATOR) throw new RangeError("restore locator does not fit");
  const bytes = await open(await locatorKey(p0), blob);
  try {
    const locator = parseLocator(JSON.parse(decoder.decode(bytes)));
    if (locator === undefined) throw new Error("invalid restore locator");
    return locator;
  } finally {
    bytes.fill(0);
  }
}

function object(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function decodeKey(raw: unknown): Uint8Array | undefined {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return undefined;
  const decoded = base64urlDecode(raw);
  return base64urlEncode(decoded) === raw ? decoded : undefined;
}

function parseLocator(raw: unknown): RestoreLocator | undefined {
  if (!object(raw)) return undefined;
  const { v, relayUrl, epoch, r_e, holders } = raw;
  if (v !== 1 || typeof relayUrl !== "string" || !URL.canParse(relayUrl)) return undefined;
  const url = new URL(relayUrl);
  if (
    url.username !== "" ||
    url.password !== "" ||
    (url.protocol !== "https:" &&
      url.protocol !== "wss:" &&
      !(url.hostname === "127.0.0.1" && url.protocol === "http:"))
  )
    return undefined;
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch <= 0) return undefined;
  const secret = decodeKey(r_e);
  if (secret === undefined || !Array.isArray(holders) || holders.length < 2 || holders.length > 8) return undefined;
  const parsed: RestoreHolder[] = [];
  for (const holder of holders) {
    if (!object(holder)) return undefined;
    const { hostId, hostKey } = holder;
    if (
      typeof hostId !== "string" ||
      !HOST_ID.test(hostId) ||
      typeof hostKey !== "string" ||
      decodeKey(hostKey) === undefined
    )
      return undefined;
    if (parsed.some((prior) => prior.hostId === hostId)) return undefined;
    parsed.push({ hostId, hostKey });
  }
  return { v, relayUrl, epoch, r_e: secret, holders: parsed };
}
