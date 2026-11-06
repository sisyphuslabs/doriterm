import { checkBody, checkVapid, MAX_BODY, Refusal, targetOf } from "./request.ts";
import {
  type ApnsCredentials,
  ApnsSender,
  type FcmCredentials,
  FcmSender,
  type Outcome,
  type UpstreamFetch,
} from "./senders.ts";

export interface BridgeConfig {
  readonly apns?: ApnsCredentials | undefined;
  readonly fcm?: FcmCredentials | undefined;
}

export interface BridgeDeps {
  readonly fetch?: UpstreamFetch | undefined;
  readonly now?: (() => number) | undefined;
  readonly log?: ((line: string) => void) | undefined;
}

/** APNs and FCM both keep a push for at most four weeks. */
const MAX_TTL_S = 28 * 24 * 60 * 60;

function ttlOf(header: string | null): number {
  const ttl = Number(header ?? "0");
  if (!Number.isSafeInteger(ttl) || ttl < 0) throw new Refusal(400, "TTL is not a whole number of seconds");
  return Math.min(ttl, MAX_TTL_S);
}

const reply = (status: number, text = ""): Response =>
  new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

const replyOf = (outcome: Outcome): Response => {
  switch (outcome.kind) {
    case "sent":
      return reply(201);
    case "gone":
      return reply(410, "the device token is no longer registered");
    case "failed":
      // Throttled stays 429 so a sender can back off; anything else upstream is a bad gateway, never the host's fault.
      return reply(outcome.status === 429 ? 429 : 502, "the push service refused the push");
  }
};

/** Reads at most `MAX_BODY` bytes: a body without a length (chunked) is refused as soon as it passes the cap. */
async function readBody(request: Request): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY) throw new Refusal(413, "body too large");
  const body = new Uint8Array(MAX_BODY);
  let length = 0;
  const reader = request.body?.getReader();
  if (reader === undefined) return body.subarray(0, 0);
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a stream is read chunk by chunk, in order
    const { done, value } = await reader.read();
    if (done) return body.subarray(0, length);
    if (length + value.byteLength > MAX_BODY) {
      // oxlint-disable-next-line no-await-in-loop -- the loop ends here: the stream is cancelled once, then refused
      await reader.cancel();
      throw new Refusal(413, "body too large");
    }
    body.set(value, length);
    length += value.byteLength;
  }
}

/**
 * The push bridge (#705): takes a Web Push request (RFC 8030 with RFC 8291 `aes128gcm` and RFC 8292 VAPID) addressed to
 * a native app's APNs or FCM token, and forwards the ciphertext unchanged. It never holds a key that opens a notice:
 * only the app does. Portable: a `fetch` handler that runs on Workers, Bun or Node.
 */
export function createBridge(config: BridgeConfig, deps: BridgeDeps = {}): (request: Request) => Promise<Response> {
  const fetch = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const apns = config.apns === undefined ? undefined : new ApnsSender(config.apns, fetch);
  const fcm = config.fcm === undefined ? undefined : new FcmSender(config.fcm, fetch);
  return async (request) => {
    const url = new URL(request.url);
    const target = targetOf(url);
    if (target === undefined) return reply(404);
    if (request.method !== "POST") return reply(405);
    try {
      const body = await readBody(request);
      checkBody(body, request.headers.get("content-encoding"));
      await checkVapid(request.headers.get("authorization"), url.origin, now());
      const urgency = request.headers.get("urgency") ?? "normal";
      const push = {
        token: target.token,
        body,
        ttl: ttlOf(request.headers.get("ttl")),
        urgent: urgency === "high" || urgency === "normal",
      };
      if (target.provider === "fcm") {
        return fcm === undefined ? reply(503, "FCM is not configured") : replyOf(await fcm.send(push, now()));
      }
      if (apns === undefined) return reply(503, "APNs is not configured");
      return replyOf(await apns.send(push, target.provider === "apns-sandbox", now()));
    } catch (error) {
      if (error instanceof Refusal) return reply(error.status, error.message);
      deps.log?.(`push-bridge: ${target.provider} push failed: ${String(error)}`);
      return reply(502, "the push could not be forwarded");
    }
  };
}
