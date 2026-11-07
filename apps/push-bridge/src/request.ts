import { base64urlDecode } from "@doriface/crypto";

/** The longest body the bridge forwards: one RFC 8188 record from a P-256 sender, far above the host's 230 bytes. */
export const MAX_BODY = 1024;
/** salt (16) + record size (4) + key id length (1) + a 65-byte P-256 key + the 16-byte AES-GCM tag. */
const MIN_BODY = 16 + 4 + 1 + 65 + 16;
/** RFC 8292 section 2: a JWT that lives longer than 24 hours is refused. */
const MAX_VAPID_LIFETIME_S = 24 * 60 * 60;

export type Provider = "apns" | "apns-sandbox" | "fcm";

export interface Target {
  readonly provider: Provider;
  readonly token: string;
}

const APNS_TOKEN = /^[0-9a-f]{64,200}$/i;
const FCM_TOKEN = /^[\w:-]{1,512}$/;

/** `/v1/apns/<hex>`, `/v1/apns-sandbox/<hex>` or `/v1/fcm/<token>`; anything else is no target. */
export function targetOf(url: URL): Target | undefined {
  const match = /^\/v1\/(apns|apns-sandbox|fcm)\/([^/]+)$/.exec(url.pathname);
  const [, provider, token] = match ?? [];
  if (token === undefined) return undefined;
  if (provider === "fcm") return FCM_TOKEN.test(token) ? { provider, token } : undefined;
  // APNs reads a device token in any letter case as one device, so the bridge keeps one form: the per-token limit counts
  // every spelling of a token together, and APNs receives the token as the bridge counted it (#830).
  if (provider === "apns" || provider === "apns-sandbox")
    return APNS_TOKEN.test(token) ? { provider, token: token.toLowerCase() } : undefined;
  return undefined;
}

export class Refusal extends Error {
  override readonly name = "Refusal";
  readonly status: number;

  constructor(status: number, reason: string) {
    super(reason);
    this.status = status;
  }
}

/** The body is exactly one `aes128gcm` record (RFC 8188) whose key id is an uncompressed P-256 key, as RFC 8291 sends. */
export function checkBody(body: Uint8Array, encoding: string | null): void {
  if (encoding?.toLowerCase() !== "aes128gcm") throw new Refusal(400, "content-encoding is not aes128gcm");
  if (body.byteLength > MAX_BODY) throw new Refusal(413, "body too large");
  if (body.byteLength < MIN_BODY) throw new Refusal(400, "body too short");
  const recordSize = new DataView(body.buffer, body.byteOffset).getUint32(16);
  if (body[20] !== 65 || body[21] !== 4) throw new Refusal(400, "the key id is not an uncompressed P-256 key");
  if (recordSize < body.byteLength - 86) throw new Refusal(400, "more than one record");
}

const json = (part: string): unknown => JSON.parse(new TextDecoder().decode(base64urlDecode(part)));
const own = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

/**
 * RFC 8292: `Authorization: vapid t=<JWT>, k=<key>`, an ES256 JWT signed by `k` whose audience is this bridge's origin
 * and which has not expired. The bridge forwards nothing that a push service would refuse to take from the host.
 */
export async function checkVapid(header: string | null, origin: string, nowMs: number): Promise<void> {
  const match = /^vapid\s+t=([\w-]+)\.([\w-]+)\.([\w-]+),\s*k=([\w-]+)$/i.exec(header?.trim() ?? "");
  const [, head, claims, signature, key] = match ?? [];
  if (head === undefined || claims === undefined || signature === undefined || key === undefined) {
    throw new Refusal(401, "no VAPID authorization");
  }
  let parsedHead: unknown;
  let parsedClaims: unknown;
  try {
    parsedHead = json(head);
    parsedClaims = json(claims);
  } catch {
    throw new Refusal(401, "a malformed VAPID token");
  }
  if (typeof parsedHead !== "object" || parsedHead === null || Reflect.get(parsedHead, "alg") !== "ES256") {
    throw new Refusal(401, "the VAPID token is not ES256");
  }
  const raw = base64urlDecode(key);
  if (raw.byteLength !== 65 || raw[0] !== 4) throw new Refusal(401, "the VAPID key is not a P-256 key");
  let publicKey: CryptoKey;
  try {
    publicKey = await crypto.subtle.importKey("raw", own(raw), { name: "ECDSA", namedCurve: "P-256" }, false, [
      "verify",
    ]);
  } catch {
    throw new Refusal(401, "the VAPID key is not on P-256");
  }
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    own(base64urlDecode(signature)),
    new TextEncoder().encode(`${head}.${claims}`),
  );
  if (!valid) throw new Refusal(401, "the VAPID signature does not verify");
  const aud = typeof parsedClaims === "object" && parsedClaims !== null ? Reflect.get(parsedClaims, "aud") : undefined;
  const exp = typeof parsedClaims === "object" && parsedClaims !== null ? Reflect.get(parsedClaims, "exp") : undefined;
  if (aud !== origin) {
    throw new Refusal(401, "the VAPID token is for another push service");
  }
  const now = Math.floor(nowMs / 1000);
  if (typeof exp !== "number" || exp <= now || exp > now + MAX_VAPID_LIFETIME_S) {
    throw new Refusal(401, "the VAPID token has expired or lives too long");
  }
}
