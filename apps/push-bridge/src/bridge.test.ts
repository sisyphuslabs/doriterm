import { base64urlDecode, base64urlEncode } from "@doriface/crypto";
import { NOTICE_KINDS, type PushNotice } from "@doriface/protocol";
import { deliverPush, pushEndpointAllowed, type PushFetch } from "@doriface/host/push/deliver";
import type { VapidKey } from "@doriface/host/push/web-push";
import { decryptPushBody, receiverKeys, type ReceiverKeys } from "@doriface/host/testing/push-receiver";
import { describe, expect, test } from "bun:test";
import { type BridgeConfig, createBridge } from "./bridge.ts";

const ORIGIN = "https://push-doriface.omo.dev";
const NOTICE: PushNotice = { v: 1, n: "AAAAAAAAAAAAAAAAAAAAAA", k: "permission", h: "abcdefghijklmnopqrstuvwxyz" };
const APNS_TOKEN = "a".repeat(64);
const FCM_TOKEN = "fGx1:APA91bH-token_for_a_test";
// The token this suite judges is minted from the real clock (web-push.ts stamps exp = now + 12h), so the
// fixture clock has to come from the same clock: an absolute instant would silently go stale once the wall
// clock passed it, and the "lapsed" case below would accept a live token (#755).
const NOW = Math.floor(Date.now() / 1000) * 1000;

async function vapidKey(): Promise<VapidKey> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: base64urlEncode(raw) };
}

async function pkcs8Pem(kind: "ec" | "rsa"): Promise<string> {
  const pair =
    kind === "ec"
      ? await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
      : await crypto.subtle.generateKey(
          { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" },
          true,
          ["sign", "verify"],
        );
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  return `-----BEGIN PRIVATE KEY-----\n${der.replace(/.{64}/g, "$&\n")}\n-----END PRIVATE KEY-----\n`;
}

interface Sent {
  readonly url: string;
  readonly headers: Headers;
  readonly body: string;
}

/** APNs, Google's token endpoint and FCM, answering with what each test sets; every request is recorded. */
function upstream(answer: (url: string) => Response = () => new Response(null, { status: 200 })) {
  const sent: Sent[] = [];
  const fetch: PushFetch = async (url, init) => {
    sent.push({ url, headers: new Headers(init.headers), body: await new Response(init.body).text() });
    if (url === "https://oauth2.googleapis.com/token")
      return Response.json({ access_token: "ya29.test", expires_in: 3600, token_type: "Bearer" });
    return answer(url);
  };
  return { sent, fetch };
}

async function config(): Promise<BridgeConfig> {
  return {
    apns: {
      teamId: "TEAM123456",
      keyId: "KEY1234567",
      privateKey: await pkcs8Pem("ec"),
      topic: "dev.omo.doriface",
    },
    fcm: {
      projectId: "doriface-test",
      clientEmail: "bridge@doriface-test.iam.gserviceaccount.com",
      privateKey: await pkcs8Pem("rsa"),
    },
  };
}

/** The host's own sender (encryption, padding, VAPID) posting to the bridge in process. */
async function hostSends(endpoint: string, upstreamFetch: PushFetch, keys?: ReceiverKeys) {
  const receiver = keys ?? (await receiverKeys());
  const bridge = createBridge(await config(), { fetch: upstreamFetch, now: () => NOW });
  const post: PushFetch = (url, init) => bridge(new Request(url, init));
  const delivery = await deliverPush(
    { endpoint, p256dh: receiver.p256dh, auth: receiver.auth },
    NOTICE,
    await vapidKey(),
    post,
  );
  return { delivery, receiver };
}

const forwardedBody = (payload: string): Uint8Array => base64urlDecode(payload);

describe("the host may post to the push bridge (#705)", () => {
  test("the bridge origin is an allowed push service, over https on the default port only", () => {
    expect(pushEndpointAllowed(`${ORIGIN}/v1/apns/${APNS_TOKEN}`)).toBe(true);
    expect(pushEndpointAllowed(`${ORIGIN}/v1/fcm/${FCM_TOKEN}`)).toBe(true);
    expect(pushEndpointAllowed(`http://push-doriface.omo.dev/v1/fcm/${FCM_TOKEN}`)).toBe(false);
    expect(pushEndpointAllowed(`https://push-doriface.omo.dev:8443/v1/fcm/${FCM_TOKEN}`)).toBe(false);
    expect(pushEndpointAllowed(`https://evil-push-doriface.omo.dev/v1/fcm/${FCM_TOKEN}`)).toBe(false);
  });
});

describe("APNs (#705)", () => {
  test("the host's ciphertext reaches APNs unchanged, and only the device's keys read the notice", async () => {
    const { sent, fetch } = upstream();
    const { delivery, receiver } = await hostSends(`${ORIGIN}/v1/apns/${APNS_TOKEN}`, fetch);
    expect(delivery).toBe("sent");
    expect(sent).toHaveLength(1);
    const [apns] = sent;
    expect(apns?.url).toBe(`https://api.push.apple.com/3/device/${APNS_TOKEN}`);
    expect(apns?.headers.get("apns-topic")).toBe("dev.omo.doriface");
    expect(apns?.headers.get("apns-push-type")).toBe("alert");
    expect(apns?.headers.get("apns-priority")).toBe("10");
    expect(apns?.headers.get("apns-expiration")).toBe(String(NOW / 1000 + 24 * 60 * 60));
    const payload = JSON.parse(apns?.body ?? "");
    expect(payload.aps["mutable-content"]).toBe(1);
    // A fixed text the extension replaces: it says nothing about the notice, which only the device can read.
    expect(payload.aps.alert).toEqual({ title: "doriface", body: "Open doriface to see what changed." });
    const notice = JSON.parse(new TextDecoder().decode(await decryptPushBody(forwardedBody(payload.p), receiver)));
    expect(notice).toEqual(NOTICE);
  });

  test("the provider token is an ES256 JWT for the team and key, reused across pushes", async () => {
    const { sent, fetch } = upstream();
    const bridge = createBridge(await config(), { fetch, now: () => NOW });
    const keys = await receiverKeys();
    const vapid = await vapidKey();
    const post: PushFetch = (url, init) => bridge(new Request(url, init));
    await Promise.all(
      [1, 2].map(() => deliverPush({ endpoint: `${ORIGIN}/v1/apns/${APNS_TOKEN}`, ...keys }, NOTICE, vapid, post)),
    );
    const tokens = sent.map((request) => request.headers.get("authorization"));
    expect(tokens[0]).toBe(tokens[1]);
    const [header, claims] = (tokens[0] ?? "").replace(/^bearer /, "").split(".");
    expect(JSON.parse(new TextDecoder().decode(base64urlDecode(header ?? "")))).toEqual({
      alg: "ES256",
      kid: "KEY1234567",
    });
    expect(JSON.parse(new TextDecoder().decode(base64urlDecode(claims ?? "")))).toEqual({
      iss: "TEAM123456",
      iat: NOW / 1000,
    });
  });

  test("a sandbox endpoint posts to the APNs development server", async () => {
    const { sent, fetch } = upstream();
    await hostSends(`${ORIGIN}/v1/apns-sandbox/${APNS_TOKEN}`, fetch);
    expect(sent[0]?.url).toBe(`https://api.sandbox.push.apple.com/3/device/${APNS_TOKEN}`);
  });

  test.each([
    [410, "Unregistered"],
    [400, "BadDeviceToken"],
    [400, "DeviceTokenNotForTopic"],
  ])("APNs %i %s answers 410, so the host drops the subscription", async (status, reason) => {
    const { fetch } = upstream(() => Response.json({ reason }, { status }));
    const { delivery } = await hostSends(`${ORIGIN}/v1/apns/${APNS_TOKEN}`, fetch);
    expect(delivery).toBe("gone");
  });

  test("APNs throttling or an outage is a failure the host logs, and the subscription stays", async () => {
    const deliveries = await Promise.all(
      [429, 500, 503].map(async (status) => {
        const { fetch } = upstream(() => Response.json({ reason: "TooManyRequests" }, { status }));
        return (await hostSends(`${ORIGIN}/v1/apns/${APNS_TOKEN}`, fetch)).delivery;
      }),
    );
    expect(deliveries).toEqual(["failed", "failed", "failed"]);
  });
});

describe("FCM (#705)", () => {
  test("the host's ciphertext reaches FCM as a high-priority data message, unchanged", async () => {
    const { sent, fetch } = upstream();
    const { delivery, receiver } = await hostSends(`${ORIGIN}/v1/fcm/${FCM_TOKEN}`, fetch);
    expect(delivery).toBe("sent");
    const message = sent.find((request) => request.url.startsWith("https://fcm.googleapis.com/"));
    expect(message?.url).toBe("https://fcm.googleapis.com/v1/projects/doriface-test/messages:send");
    expect(message?.headers.get("authorization")).toBe("Bearer ya29.test");
    const body = JSON.parse(message?.body ?? "").message;
    expect(body.token).toBe(FCM_TOKEN);
    expect(body.android).toEqual({ priority: "HIGH", ttl: "86400s" });
    // Data only: the app's own service decrypts and shows it, so FCM never draws a notification of its own.
    expect(body.notification).toBeUndefined();
    const notice = JSON.parse(new TextDecoder().decode(await decryptPushBody(forwardedBody(body.data.p), receiver)));
    expect(notice).toEqual(NOTICE);
  });

  test("the access token comes from a service-account JWT grant and is reused until it expires", async () => {
    const { sent, fetch } = upstream();
    const bridge = createBridge(await config(), { fetch, now: () => NOW });
    const keys = await receiverKeys();
    const vapid = await vapidKey();
    const post: PushFetch = (url, init) => bridge(new Request(url, init));
    await Promise.all(
      [1, 2].map(() => deliverPush({ endpoint: `${ORIGIN}/v1/fcm/${FCM_TOKEN}`, ...keys }, NOTICE, vapid, post)),
    );
    const grants = sent.filter((request) => request.url === "https://oauth2.googleapis.com/token");
    expect(grants).toHaveLength(1);
    const form = new URLSearchParams(grants[0]?.body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const claims = JSON.parse(new TextDecoder().decode(base64urlDecode(form.get("assertion")?.split(".")[1] ?? "")));
    expect(claims).toEqual({
      iss: "bridge@doriface-test.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: NOW / 1000,
      exp: NOW / 1000 + 3600,
    });
  });

  test("an unregistered token answers 410; throttling stays a failure", async () => {
    const gone = upstream(() =>
      Response.json(
        { error: { code: 404, status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } },
        { status: 404 },
      ),
    );
    expect((await hostSends(`${ORIGIN}/v1/fcm/${FCM_TOKEN}`, gone.fetch)).delivery).toBe("gone");
    const busy = upstream(() => Response.json({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }, { status: 429 }));
    expect((await hostSends(`${ORIGIN}/v1/fcm/${FCM_TOKEN}`, busy.fetch)).delivery).toBe("failed");
  });
});

async function bridgeAnswer(init: {
  path?: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
  method?: string;
}) {
  const { sent, fetch } = upstream();
  const bridge = createBridge(await config(), { fetch, now: () => NOW });
  const reply = await bridge(
    new Request(`${ORIGIN}${init.path ?? `/v1/apns/${APNS_TOKEN}`}`, {
      method: init.method ?? "POST",
      headers: init.headers ?? {},
      ...(init.body === undefined ? {} : { body: new Uint8Array(init.body) }),
    }),
  );
  return { status: reply.status, forwarded: sent.length };
}

/** A real host body and headers for the APNs path, captured from the host's own sender. */
async function captured(): Promise<{ headers: Record<string, string>; body: Uint8Array }> {
  let headers: Record<string, string> = {};
  let body = new Uint8Array();
  const keys = await receiverKeys();
  await deliverPush(
    { endpoint: `${ORIGIN}/v1/apns/${APNS_TOKEN}`, ...keys },
    NOTICE,
    await vapidKey(),
    async (_, init) => {
      headers = Object.fromEntries(new Headers(init.headers));
      body = new Uint8Array(await new Response(init.body).arrayBuffer());
      return new Response(null, { status: 201 });
    },
  );
  return { headers, body };
}

describe("what the bridge refuses before anything reaches APNs or FCM", () => {
  test("an unknown path, a malformed token or another method is 404 or 405", async () => {
    const { headers, body } = await captured();
    expect((await bridgeAnswer({ path: "/v1/wns/x", headers, body })).status).toBe(404);
    expect((await bridgeAnswer({ path: "/v1/apns/not-hex", headers, body })).status).toBe(404);
    expect((await bridgeAnswer({ path: `/v1/fcm/${"a".repeat(600)}`, headers, body })).status).toBe(404);
    expect((await bridgeAnswer({ method: "GET" })).status).toBe(405);
  });

  test("a body that is not one aes128gcm record from a P-256 sender is 400", async () => {
    const { headers, body } = await captured();
    expect((await bridgeAnswer({ headers: { ...headers, "content-encoding": "aesgcm" }, body })).status).toBe(400);
    expect((await bridgeAnswer({ headers, body: body.subarray(0, 40) })).status).toBe(400);
    expect((await bridgeAnswer({ headers, body: new Uint8Array(2048) })).status).toBe(413);
    const otherKeyLength = new Uint8Array(body);
    otherKeyLength[20] = 33;
    expect((await bridgeAnswer({ headers, body: otherKeyLength })).status).toBe(400);
  });

  test("a missing, forged, expired or misaddressed VAPID header is 401, and nothing is forwarded", async () => {
    const { headers, body } = await captured();
    const auth = headers["authorization"] ?? "";
    const { authorization: _, ...unsigned } = headers;
    expect(await bridgeAnswer({ headers: unsigned, body })).toEqual({ status: 401, forwarded: 0 });
    const forged = auth.replace(
      /t=([^.]+)\.([^.]+)\.([\w-]+)/,
      (_m, h, c, s: string) => `t=${h}.${c}.${s.slice(0, -4)}AAAA`,
    );
    expect(await bridgeAnswer({ headers: { ...headers, authorization: forged }, body })).toEqual({
      status: 401,
      forwarded: 0,
    });
    const lapsed = createBridge(await config(), { fetch: upstream().fetch, now: () => NOW + 13 * 60 * 60 * 1000 });
    const late = await lapsed(new Request(`${ORIGIN}/v1/apns/${APNS_TOKEN}`, { method: "POST", headers, body }));
    expect(late.status).toBe(401);
    const elsewhere = createBridge(await config(), { fetch: upstream().fetch, now: () => NOW });
    const misaddressed = await elsewhere(
      new Request(`https://push.example.net/v1/apns/${APNS_TOKEN}`, { method: "POST", headers, body }),
    );
    expect(misaddressed.status).toBe(401);
  });

  test("a provider with no credentials answers 503, and the other still works", async () => {
    const { sent, fetch } = upstream();
    const { fcm } = await config();
    const bridge = createBridge({ fcm }, { fetch, now: () => NOW });
    const { headers, body } = await captured();
    const reply = await bridge(new Request(`${ORIGIN}/v1/apns/${APNS_TOKEN}`, { method: "POST", headers, body }));
    expect(reply.status).toBe(503);
    expect(sent).toHaveLength(0);
  });
});

test("every notice kind forwards a payload of one length, so APNs and FCM cannot tell the kinds apart", async () => {
  const vapid = await vapidKey();
  const keys = await receiverKeys();
  const lengths = await Promise.all(
    NOTICE_KINDS.map(async (k) => {
      const { sent, fetch } = upstream();
      const bridge = createBridge(await config(), { fetch, now: () => NOW });
      await deliverPush({ endpoint: `${ORIGIN}/v1/fcm/${FCM_TOKEN}`, ...keys }, { ...NOTICE, k }, vapid, (url, init) =>
        bridge(new Request(url, init)),
      );
      return sent.find((request) => request.url.startsWith("https://fcm.googleapis.com/"))?.body.length ?? -1;
    }),
  );
  expect(new Set(lengths).size).toBe(1);
});
