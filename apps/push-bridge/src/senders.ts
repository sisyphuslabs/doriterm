import { base64urlDecode, base64urlEncode } from "@doriface/crypto";

export type UpstreamFetch = (url: string, init: RequestInit) => Promise<Response>;

/** What the bridge answers the host with: `sent` is 201, `gone` is 410 (the host drops the subscription). */
export type Outcome =
  | { readonly kind: "sent" }
  | { readonly kind: "gone" }
  | { readonly kind: "failed"; readonly status: number };

export interface ApnsCredentials {
  readonly teamId: string;
  readonly keyId: string;
  /** The `.p8` key from Apple, PKCS #8 PEM (P-256). */
  readonly privateKey: string;
  /** The app's bundle id. */
  readonly topic: string;
}

export interface FcmCredentials {
  readonly projectId: string;
  readonly clientEmail: string;
  /** The service account's PKCS #8 PEM (RSA). */
  readonly privateKey: string;
}

export interface Push {
  readonly token: string;
  /** The host's `aes128gcm` body, unchanged. */
  readonly body: Uint8Array;
  /** Seconds the push may wait for the device (the host's `TTL`). */
  readonly ttl: number;
  readonly urgent: boolean;
}

const utf8 = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);
const jsonPart = (value: object): string => base64urlEncode(utf8(JSON.stringify(value)));

function pemBody(pem: string): Uint8Array<ArrayBuffer> {
  const base64 = pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\s+/g, "");
  return new Uint8Array(base64urlDecode(base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")));
}

async function sign(key: CryptoKey, algorithm: Parameters<SubtleCrypto["sign"]>[0], input: string): Promise<string> {
  return base64urlEncode(new Uint8Array(await crypto.subtle.sign(algorithm, key, utf8(input))));
}

/** A token kept until shortly before it lapses; one in flight is shared, so a burst of pushes signs once. */
class Cached {
  #value: Promise<{ readonly token: string; readonly until: number }> | undefined;
  readonly #make: (now: number) => Promise<{ readonly token: string; readonly until: number }>;

  constructor(make: (now: number) => Promise<{ readonly token: string; readonly until: number }>) {
    this.#make = make;
  }

  async get(now: number): Promise<string> {
    const held = this.#value === undefined ? undefined : await this.#value.catch(() => undefined);
    if (held !== undefined && held.until > now) return held.token;
    this.#value = this.#make(now);
    return (await this.#value).token;
  }

  drop(): void {
    this.#value = undefined;
  }
}

/** The fixed alert iOS shows if the app's Notification Service Extension cannot decrypt in time. */
export const APNS_FALLBACK_ALERT = { title: "Doriterm", body: "Open Doriterm to see what changed." } as const;
/** Apple refuses a provider token older than an hour and throttles one renewed more often than every 20 minutes. */
const APNS_TOKEN_REUSE_MS = 40 * 60 * 1000;
const APNS_GONE = new Set(["Unregistered", "BadDeviceToken", "DeviceTokenNotForTopic", "ExpiredToken"]);
const APNS_RETRY_TOKEN = new Set(["ExpiredProviderToken", "InvalidProviderToken"]);

export class ApnsSender {
  readonly #credentials: ApnsCredentials;
  readonly #fetch: UpstreamFetch;
  readonly #token: Cached;

  constructor(credentials: ApnsCredentials, fetch: UpstreamFetch) {
    this.#credentials = credentials;
    this.#fetch = fetch;
    let key: Promise<CryptoKey> | undefined;
    this.#token = new Cached(async (now) => {
      key ??= crypto.subtle.importKey(
        "pkcs8",
        pemBody(credentials.privateKey),
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      );
      const input = `${jsonPart({ alg: "ES256", kid: credentials.keyId })}.${jsonPart({ iss: credentials.teamId, iat: Math.floor(now / 1000) })}`;
      const token = `${input}.${await sign(await key, { name: "ECDSA", hash: "SHA-256" }, input)}`;
      return { token, until: now + APNS_TOKEN_REUSE_MS };
    });
  }

  async send(push: Push, sandbox: boolean, now: number): Promise<Outcome> {
    const host = sandbox ? "api.sandbox.push.apple.com" : "api.push.apple.com";
    const payload = JSON.stringify({
      aps: { alert: APNS_FALLBACK_ALERT, "mutable-content": 1, sound: "default" },
      p: base64urlEncode(push.body),
    });
    const post = async (): Promise<Response> =>
      this.#fetch(`https://${host}/3/device/${push.token}`, {
        method: "POST",
        headers: {
          authorization: `bearer ${await this.#token.get(now)}`,
          "apns-topic": this.#credentials.topic,
          "apns-push-type": "alert",
          "apns-priority": push.urgent ? "10" : "5",
          "apns-expiration": String(push.ttl === 0 ? 0 : Math.floor(now / 1000) + push.ttl),
          "content-type": "application/json",
        },
        body: payload,
        redirect: "error",
      });
    let response = await post();
    let reason = await reasonOf(response);
    if (response.status === 403 && APNS_RETRY_TOKEN.has(reason)) {
      this.#token.drop();
      response = await post();
      reason = await reasonOf(response);
    }
    if (response.ok) return { kind: "sent" };
    if (response.status === 410 || (response.status === 400 && APNS_GONE.has(reason))) return { kind: "gone" };
    return { kind: "failed", status: response.status };
  }
}

async function reasonOf(response: Response): Promise<string> {
  if (response.ok) {
    await response.body?.cancel();
    return "";
  }
  const value: unknown = await response.json().catch(() => undefined);
  const reason = typeof value === "object" && value !== null ? Reflect.get(value, "reason") : undefined;
  return typeof reason === "string" ? reason : "";
}

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const GRANT_LIFETIME_S = 3600;

export class FcmSender {
  readonly #credentials: FcmCredentials;
  readonly #fetch: UpstreamFetch;
  readonly #token: Cached;

  constructor(credentials: FcmCredentials, fetch: UpstreamFetch) {
    this.#credentials = credentials;
    this.#fetch = fetch;
    let key: Promise<CryptoKey> | undefined;
    this.#token = new Cached(async (now) => {
      key ??= crypto.subtle.importKey(
        "pkcs8",
        pemBody(credentials.privateKey),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const iat = Math.floor(now / 1000);
      const claims = {
        iss: credentials.clientEmail,
        scope: FCM_SCOPE,
        aud: GOOGLE_TOKEN_URL,
        iat,
        exp: iat + GRANT_LIFETIME_S,
      };
      const input = `${jsonPart({ alg: "RS256", typ: "JWT" })}.${jsonPart(claims)}`;
      const assertion = `${input}.${await sign(await key, { name: "RSASSA-PKCS1-v1_5" }, input)}`;
      const response = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
        redirect: "error",
      });
      const grant: unknown = await response.json().catch(() => undefined);
      const token = typeof grant === "object" && grant !== null ? Reflect.get(grant, "access_token") : undefined;
      const lifetime = typeof grant === "object" && grant !== null ? Reflect.get(grant, "expires_in") : undefined;
      if (!response.ok || typeof token !== "string")
        throw new Error(`Google refused the token grant (${response.status})`);
      const seconds = typeof lifetime === "number" ? lifetime : GRANT_LIFETIME_S;
      return { token, until: now + (seconds - 60) * 1000 };
    });
  }

  async send(push: Push, now: number): Promise<Outcome> {
    const message = {
      message: {
        token: push.token,
        data: { p: base64urlEncode(push.body) },
        android: { priority: push.urgent ? "HIGH" : "NORMAL", ttl: `${push.ttl}s` },
      },
    };
    const post = async (): Promise<Response> =>
      this.#fetch(`https://fcm.googleapis.com/v1/projects/${this.#credentials.projectId}/messages:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${await this.#token.get(now)}`, "content-type": "application/json" },
        body: JSON.stringify(message),
        redirect: "error",
      });
    let response = await post();
    if (response.status === 401) {
      await response.body?.cancel();
      this.#token.drop();
      response = await post();
    }
    if (response.ok) {
      await response.body?.cancel();
      return { kind: "sent" };
    }
    // Only FCM's own UNREGISTERED says the token is gone: a bare 404 (a wrong project id) must not make the host drop
    // every Android subscription.
    const error: unknown = await response.json().catch(() => undefined);
    return errorCodes(error).includes("UNREGISTERED") ? { kind: "gone" } : { kind: "failed", status: response.status };
  }
}

function errorCodes(value: unknown): readonly string[] {
  const error = typeof value === "object" && value !== null ? Reflect.get(value, "error") : undefined;
  const details = typeof error === "object" && error !== null ? Reflect.get(error, "details") : undefined;
  if (!Array.isArray(details)) return [];
  return details.flatMap((detail: unknown) => {
    const code = typeof detail === "object" && detail !== null ? Reflect.get(detail, "errorCode") : undefined;
    return typeof code === "string" ? [code] : [];
  });
}
