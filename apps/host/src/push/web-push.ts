import { base64urlDecode, base64urlEncode, concatBytes } from "@doriface/crypto";
import type { PushSubscriptionKeys } from "@doriface/protocol";

/** RFC 8188's record size the body declares; a notice is far below one record. */
const RECORD_SIZE = 4096;
const P256 = { name: "ECDH", namedCurve: "P-256" } as const;

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const own = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey("raw", own(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, own(data)));
}

/** The application server's one-off key pair; tests pass RFC 8291's own. */
export interface SenderKey {
  readonly privateKey: CryptoKey;
  /** 65 bytes, uncompressed. */
  readonly publicKey: Uint8Array;
}

export async function ephemeralSenderKey(): Promise<SenderKey> {
  const pair = await crypto.subtle.generateKey(P256, true, ["deriveBits"]);
  return {
    privateKey: pair.privateKey,
    publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
  };
}

export interface EncryptOptions {
  readonly sender?: SenderKey;
  readonly salt?: Uint8Array;
  /**
   * The record's plaintext size, padding included (RFC 8188 section 2: zero octets after the 0x02 delimiter), so
   * every body of one sender has one length and its size says nothing about what it carries.
   */
  readonly padTo?: number;
}

/**
 * RFC 8291 message encryption with RFC 8188 `aes128gcm`: only the browser holding the subscription's private key and
 * auth secret can read the body; the push service, and anyone between, sees ciphertext.
 */
export async function encryptPushPayload(
  plaintext: Uint8Array,
  subscription: Pick<PushSubscriptionKeys, "p256dh" | "auth">,
  options: EncryptOptions = {},
): Promise<Uint8Array> {
  const uaPublic = base64urlDecode(subscription.p256dh);
  const authSecret = base64urlDecode(subscription.auth);
  if (uaPublic.byteLength !== 65 || authSecret.byteLength !== 16) throw new Error("a malformed push subscription");
  const sender = options.sender ?? (await ephemeralSenderKey());
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const peer = await crypto.subtle.importKey("raw", own(uaPublic), P256, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, sender.privateKey, 256),
  );
  const prkKey = await hmac(authSecret, ecdhSecret);
  const keyInfo = concatBytes(utf8("WebPush: info\0"), uaPublic, sender.publicKey, Uint8Array.of(1));
  const ikm = await hmac(prkKey, keyInfo);
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, utf8("Content-Encoding: aes128gcm\0\x01"))).subarray(0, 16);
  const nonce = (await hmac(prk, utf8("Content-Encoding: nonce\0\x01"))).subarray(0, 12);
  const aes = await crypto.subtle.importKey("raw", own(cek), "AES-GCM", false, ["encrypt"]);
  const record = new Uint8Array(Math.max(plaintext.byteLength + 1, options.padTo ?? 0));
  record.set(plaintext);
  record[plaintext.byteLength] = 2;
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: own(nonce) }, aes, own(record));
  const header = new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = sender.publicKey.byteLength;
  return concatBytes(header, sender.publicKey, new Uint8Array(sealed));
}

export interface VapidKey {
  readonly privateKey: CryptoKey;
  /** base64url of the 65-byte public key: the `applicationServerKey` the browser subscribed with. */
  readonly publicKey: string;
}

/** Who runs this sender, for a push service that must reach someone about abuse (RFC 8292 section 2.1). */
export const VAPID_SUBJECT = "https://github.com/sisyphuslabs/doriterm";
const VAPID_LIFETIME_S = 12 * 60 * 60;

const jsonPart = (value: object): string => base64urlEncode(utf8(JSON.stringify(value)));

/** RFC 8292 `Authorization: vapid t=<JWT>, k=<key>` for one endpoint's push service. */
export async function vapidAuthorization(endpoint: string, key: VapidKey, nowMs = Date.now()): Promise<string> {
  const claims = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(nowMs / 1000) + VAPID_LIFETIME_S,
    sub: VAPID_SUBJECT,
  };
  const signingInput = `${jsonPart({ typ: "JWT", alg: "ES256" })}.${jsonPart(claims)}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key.privateKey,
    own(utf8(signingInput)),
  );
  return `vapid t=${signingInput}.${base64urlEncode(new Uint8Array(signature))}, k=${key.publicKey}`;
}
