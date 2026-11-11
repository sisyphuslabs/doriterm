import { base64urlDecode, base64urlEncode } from "@doriface/crypto";
import { NOTICE_KINDS, type PushNotice } from "@doriface/protocol";
import { deliverPush, pushEndpointAllowed, type PushFetch } from "@doriface/host/push/deliver";
import type { VapidKey } from "@doriface/host/push/web-push";
import { decryptPushBody, receiverKeys, type ReceiverKeys } from "@doriface/host/testing/push-receiver";
import { describe, expect, test } from "bun:test";
import { type BridgeConfig, createBridge, type TokenLimiter, tokenKey } from "./bridge.ts";
import { limiterOf } from "./worker.ts";

const ORIGIN = "https://push-doriface.omo.dev";
const NOTICE: PushNotice = { v: 1, n: "AAAAAAAAAAAAAAAAAAAAAA", k: "permission", h: "abcdefghijklmnopqrstuvwxyz" };
const APNS_TOKEN = "a".repeat(64);
const FCM_TOKEN = "fGx1:APA91bH-token_for_a_test";
const NOW = Date.UTC(2026, 10, 6, 7, 0, 0);

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
  const statuses: number[] = [];
  const post: PushFetch = async (url, init) => {
    const reply = await bridge(new Request(url, init));
    statuses.push(reply.status);
    return reply;
  };
  const delivery = await deliverPush(
    { endpoint, p256dh: receiver.p256dh, auth: receiver.auth },
    NOTICE,
    await vapidKey(),
    post,
    { now: () => NOW },
  );
  // What the bridge itself answered: the host folds 429 and 5xx into one `failed`, so the status is checked here.
  return { delivery, receiver, status: statuses.at(-1) };
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
    expect(payload.aps.alert).toEqual({ title: "Doriterm", body: "Open Doriterm to see what changed." });
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
      [1, 2].map(() =>
        deliverPush({ endpoint: `${ORIGIN}/v1/apns/${APNS_TOKEN}`, ...keys }, NOTICE, vapid, post, { now: () => NOW }),
      ),
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
    [400, "ExpiredToken"],
  ])("APNs %i %s answers 410, so the host drops the subscription", async (status, reason) => {
    const { fetch } = upstream(() => Response.json({ reason }, { status }));
    const { delivery } = await hostSends(`${ORIGIN}/v1/apns/${APNS_TOKEN}`, fetch);
    expect(delivery).toBe("gone");
  });

  test("APNs throttling stays 429 and an outage is 502: a failure the host logs, and the subscription stays", async () => {
    const answers = await Promise.all(
      [429, 500, 503].map(async (status) => {
        const { fetch } = upstream(() => Response.json({ reason: "TooManyRequests" }, { status }));
        const { delivery, status: answered } = await hostSends(`${ORIGIN}/v1/apns/${APNS_TOKEN}`, fetch);
        return [delivery, answered];
      }),
    );
    expect(answers).toEqual([
      ["failed", 429],
      ["failed", 502],
      ["failed", 502],
    ]);
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
      [1, 2].map(() =>
        deliverPush({ endpoint: `${ORIGIN}/v1/fcm/${FCM_TOKEN}`, ...keys }, NOTICE, vapid, post, { now: () => NOW }),
      ),
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
    const unregistered = await hostSends(`${ORIGIN}/v1/fcm/${FCM_TOKEN}`, gone.fetch);
    expect([unregistered.delivery, unregistered.status]).toEqual(["gone", 410]);
    const busy = upstream(() => Response.json({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }, { status: 429 }));
    const throttled = await hostSends(`${ORIGIN}/v1/fcm/${FCM_TOKEN}`, busy.fetch);
    expect([throttled.delivery, throttled.status]).toEqual(["failed", 429]);
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

/**
 * A real host body and headers for the APNs path, captured from the host's own sender. `now` is the clock the VAPID
 * header is signed with: every case here pairs it with the clock its bridge checks that header against, so no assertion
 * depends on the wall clock (#750).
 */
async function captured(now: () => number = () => NOW): Promise<{ headers: Record<string, string>; body: Uint8Array }> {
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
    { now },
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

  // A token signed at `at` must be expired at `at + 13 h` and still good at `at`, for any `at`. The offsets include a
  // past and a future one: signing from the real clock would pass only for instants close to the wall clock, which is
  // how this case went red at 2026-11-06T08:00Z.
  test.each([
    ["three days before the anchor", -3 * 24 * 60 * 60 * 1000],
    ["at the anchor", 0],
    ["thirty-seven days after the anchor", 37 * 24 * 60 * 60 * 1000],
  ])("the header's life is measured from the clock that signed it, %s (#750)", async (_where, offset) => {
    const twelveHours = 12 * 60 * 60 * 1000;
    const at = NOW + offset;
    const { headers, body } = await captured(() => at);
    const lapsed = createBridge(await config(), {
      fetch: upstream().fetch,
      now: () => at + twelveHours + 60 * 60 * 1000,
    });
    const late = await lapsed(new Request(`${ORIGIN}/v1/apns/${APNS_TOKEN}`, { method: "POST", headers, body }));
    expect(late.status).toBe(401);
    const live = createBridge(await config(), { fetch: upstream().fetch, now: () => at });
    const onTime = await live(new Request(`${ORIGIN}/v1/apns/${APNS_TOKEN}`, { method: "POST", headers, body }));
    expect(onTime.status).toBe(201);
  });

  test("a provider with no credentials answers 503, and the other still works", async () => {
    const { sent, fetch } = upstream();
    const { fcm } = await config();
    const bridge = createBridge({ fcm }, { fetch, now: () => NOW });
    const { headers, body } = await captured();
    const reply = await bridge(new Request(`${ORIGIN}/v1/apns/${APNS_TOKEN}`, { method: "POST", headers, body }));
    expect(reply.status).toBe(503);
    expect(sent).toHaveLength(0);
    const keys = await receiverKeys();
    const fcmDelivery = await deliverPush(
      { endpoint: `${ORIGIN}/v1/fcm/${FCM_TOKEN}`, ...keys },
      NOTICE,
      await vapidKey(),
      (url, init) => bridge(new Request(url, init)),
      { now: () => NOW },
    );
    expect(fcmDelivery).toBe("sent");
    expect(sent.some((request) => request.url.startsWith("https://fcm.googleapis.com/"))).toBe(true);
  });

  test("a body sent without a length is refused once it passes the cap, before it is read whole", async () => {
    const { sent, fetch } = upstream();
    const bridge = createBridge(await config(), { fetch, now: () => NOW });
    const { headers } = await captured();
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(512));
      },
    });
    const { "content-length": _length, ...chunked } = headers;
    const reply = await bridge(
      new Request(`${ORIGIN}/v1/apns/${APNS_TOKEN}`, {
        method: "POST",
        headers: chunked,
        body: endless,
        duplex: "half",
      } as RequestInit),
    );
    expect(reply.status).toBe(413);
    expect(pulled).toBeLessThan(5);
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
      await deliverPush(
        { endpoint: `${ORIGIN}/v1/fcm/${FCM_TOKEN}`, ...keys },
        { ...NOTICE, k },
        vapid,
        (url, init) => bridge(new Request(url, init)),
        { now: () => NOW },
      );
      return sent.find((request) => request.url.startsWith("https://fcm.googleapis.com/"))?.body.length ?? -1;
    }),
  );
  // Every kind reached FCM, and all of them with one length: a refusal would leave the -1 above and still pass the set
  // check, so the floor is what keeps this case honest.
  for (const length of lengths) expect(length).toBeGreaterThan(0);
  expect(new Set(lengths).size).toBe(1);
});

/** One bridge whose clock the test moves, and the host signing on that same clock. */
async function clockedBridge(answer?: (url: string) => Response) {
  let at = NOW;
  const { sent, fetch } = upstream(answer);
  const bridge = createBridge(await config(), { fetch, now: () => at });
  const keys = await receiverKeys();
  const vapid = await vapidKey();
  const send = async (endpoint: string, when: number) => {
    at = when;
    let status = 0;
    const delivery = await deliverPush(
      { endpoint, ...keys },
      NOTICE,
      vapid,
      async (url, init) => {
        const reply = await bridge(new Request(url, init));
        status = reply.status;
        return reply;
      },
      { now: () => when },
    );
    return { delivery, status };
  };
  return { sent, send };
}

const MINUTE = 60 * 1000;
const authOf = (sent: readonly Sent[], prefix: string): (string | null)[] =>
  sent.filter((request) => request.url.startsWith(prefix)).map((request) => request.headers.get("authorization"));

describe("provider tokens: reuse, expiry and renewal (#717 review)", () => {
  test("the APNs provider token is reused for 40 minutes and made again after", async () => {
    const { sent, send } = await clockedBridge();
    const apns = `${ORIGIN}/v1/apns/${APNS_TOKEN}`;
    await send(apns, NOW);
    await send(apns, NOW + 39 * MINUTE);
    await send(apns, NOW + 41 * MINUTE);
    const [first, reused, renewed] = authOf(sent, "https://api.push.apple.com/");
    expect(reused).toBe(first);
    expect(renewed).not.toBe(first);
  });

  test("an APNs 403 for an expired or invalid provider token is retried once with a new token", async () => {
    for (const reason of ["ExpiredProviderToken", "InvalidProviderToken"]) {
      let calls = 0;
      // oxlint-disable-next-line no-await-in-loop -- each reason gets its own bridge and its own call count
      const { sent, send } = await clockedBridge(() =>
        ++calls === 1 ? Response.json({ reason }, { status: 403 }) : new Response(null, { status: 200 }),
      );
      // oxlint-disable-next-line no-await-in-loop -- see above
      expect(await send(`${ORIGIN}/v1/apns/${APNS_TOKEN}`, NOW)).toEqual({ delivery: "sent", status: 201 });
      const tokens = authOf(sent, "https://api.push.apple.com/");
      expect(tokens).toHaveLength(2);
      expect(tokens[1]).not.toBe(tokens[0]);
    }
  });

  test("the FCM access token is reused until a minute before it expires, then granted again", async () => {
    const { sent, send } = await clockedBridge();
    const fcm = `${ORIGIN}/v1/fcm/${FCM_TOKEN}`;
    await send(fcm, NOW);
    await send(fcm, NOW + 58 * MINUTE);
    expect(sent.filter((request) => request.url === "https://oauth2.googleapis.com/token")).toHaveLength(1);
    // Inside the last minute before `expires_in` (3600 s): a new grant, not the token about to lapse.
    await send(fcm, NOW + 59.5 * MINUTE);
    expect(sent.filter((request) => request.url === "https://oauth2.googleapis.com/token")).toHaveLength(2);
  });

  test("an FCM 401 is granted a new access token and sent once more", async () => {
    let sends = 0;
    const { sent, send } = await clockedBridge((url) =>
      url.startsWith("https://fcm.googleapis.com/") && ++sends === 1
        ? Response.json({ error: { code: 401, status: "UNAUTHENTICATED" } }, { status: 401 })
        : new Response(null, { status: 200 }),
    );
    expect(await send(`${ORIGIN}/v1/fcm/${FCM_TOKEN}`, NOW)).toEqual({ delivery: "sent", status: 201 });
    expect(sent.filter((request) => request.url === "https://oauth2.googleapis.com/token")).toHaveLength(2);
    expect(sends).toBe(2);
  });

  test("an FCM 404 without UNREGISTERED (a wrong project) is a failure, so the host keeps the subscription", async () => {
    const { send } = await clockedBridge(() =>
      Response.json(
        { error: { code: 404, status: "NOT_FOUND", message: "Requested entity was not found." } },
        { status: 404 },
      ),
    );
    expect(await send(`${ORIGIN}/v1/fcm/${FCM_TOKEN}`, NOW)).toEqual({ delivery: "failed", status: 502 });
  });
});

/** A limiter that lets `limit` pushes through per key, as the Workers binding does within one period. */
function countingLimiter(limit: number): TokenLimiter & { readonly keys: string[] } {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  return {
    keys,
    allows: async (key) => {
      keys.push(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return (counts.get(key) ?? 0) <= limit;
    },
  };
}

describe("a rate limit per device token (#830)", () => {
  test("a burst above the limit to one token is answered 429 and forwarded no further; another token is unaffected", async () => {
    const { sent, fetch } = upstream();
    const limiter = countingLimiter(3);
    const bridge = createBridge(await config(), { fetch, now: () => NOW, limiter });
    const keys = await receiverKeys();
    const vapid = await vapidKey();
    const statuses: number[] = [];
    const post: PushFetch = async (url, init) => {
      const reply = await bridge(new Request(url, init));
      statuses.push(reply.status);
      return reply;
    };
    const push = (endpoint: string) => deliverPush({ endpoint, ...keys }, NOTICE, vapid, post, { now: () => NOW });
    const burst = await Promise.all([1, 2, 3, 4, 5].map(() => push(`${ORIGIN}/v1/apns/${APNS_TOKEN}`)));
    expect(statuses.toSorted()).toEqual([201, 201, 201, 429, 429]);
    // The host folds 429 into a failure, which keeps the subscription (deliver.ts): never "gone".
    expect(burst.toSorted()).toEqual(["failed", "failed", "sent", "sent", "sent"]);
    expect(sent.filter((request) => request.url.includes(APNS_TOKEN))).toHaveLength(3);

    expect(await push(`${ORIGIN}/v1/fcm/${FCM_TOKEN}`)).toBe("sent");
    expect(statuses.at(-1)).toBe(201);
  });

  test("the limiter is keyed by a hash of provider and token, never the token itself", async () => {
    const limiter = countingLimiter(10);
    const { fetch } = upstream();
    const bridge = createBridge(await config(), { fetch, now: () => NOW, limiter });
    const keys = await receiverKeys();
    const post: PushFetch = (url, init) => bridge(new Request(url, init));
    await deliverPush({ endpoint: `${ORIGIN}/v1/apns/${APNS_TOKEN}`, ...keys }, NOTICE, await vapidKey(), post, {
      now: () => NOW,
    });
    expect(limiter.keys).toEqual([await tokenKey("apns", APNS_TOKEN)]);
    expect(limiter.keys[0]).not.toContain(APNS_TOKEN);
    expect(await tokenKey("apns", APNS_TOKEN)).not.toBe(await tokenKey("apns-sandbox", APNS_TOKEN));
  });

  test("an APNs token in another letter case counts against the same allowance and reaches APNs as one token", async () => {
    const { sent, fetch } = upstream();
    const limiter = countingLimiter(2);
    const bridge = createBridge(await config(), { fetch, now: () => NOW, limiter });
    const keys = await receiverKeys();
    const vapid = await vapidKey();
    const post: PushFetch = (url, init) => bridge(new Request(url, init));
    const push = (token: string) =>
      deliverPush({ endpoint: `${ORIGIN}/v1/apns/${token}`, ...keys }, NOTICE, vapid, post, { now: () => NOW });
    // APNs reads a device token in any letter case as the same device.
    const results = [];
    for (const token of [APNS_TOKEN.toLowerCase(), APNS_TOKEN.toUpperCase(), APNS_TOKEN.toUpperCase()]) {
      // oxlint-disable-next-line no-await-in-loop -- the limiter counts in order
      results.push(await push(token));
    }
    expect(results).toEqual(["sent", "sent", "failed"]);
    expect(new Set(limiter.keys)).toEqual(new Set([await tokenKey("apns", APNS_TOKEN.toLowerCase())]));
    expect(sent.map((request) => request.url.split("/").at(-1))).toEqual([
      APNS_TOKEN.toLowerCase(),
      APNS_TOKEN.toLowerCase(),
    ]);
  });

  test("a request the bridge refuses (no valid VAPID) spends nothing of the token's allowance", async () => {
    const limiter = countingLimiter(1);
    const bridge = createBridge(await config(), { fetch: upstream().fetch, now: () => NOW, limiter });
    const refused = await bridge(new Request(`${ORIGIN}/v1/apns/${APNS_TOKEN}`, { method: "POST", body: "x" }));
    expect(refused.status).not.toBe(429);
    expect(limiter.keys).toEqual([]);
  });

  test("a limiter that fails forwards the push unlimited and logs once per burst; only over the limit is 429 (#1124)", async () => {
    const { sent, fetch } = upstream();
    let down = true;
    const limiter = countingLimiter(1);
    const failing: TokenLimiter = {
      allows: async (key) => {
        if (down) throw new Error("rate limiting binding unavailable");
        return limiter.allows(key);
      },
    };
    const logged: string[] = [];
    const bridge = createBridge(await config(), { fetch, now: () => NOW, limiter: failing, log: (line) => logged.push(line) });
    const keys = await receiverKeys();
    const vapid = await vapidKey();
    const statuses: number[] = [];
    const post: PushFetch = async (url, init) => {
      const reply = await bridge(new Request(url, init));
      statuses.push(reply.status);
      return reply;
    };
    const push = () =>
      deliverPush({ endpoint: `${ORIGIN}/v1/apns/${APNS_TOKEN}`, ...keys }, NOTICE, vapid, post, { now: () => NOW });

    expect(await Promise.all([push(), push(), push()])).toEqual(["sent", "sent", "sent"]);
    expect(statuses).toEqual([201, 201, 201]);
    expect(sent.filter((request) => request.url.includes(APNS_TOKEN))).toHaveLength(3);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("rate limiting binding unavailable");
    expect(logged[0]).not.toContain(APNS_TOKEN);

    // Back up: the limiter's answers count again, and "over the limit" is still a 429.
    down = false;
    expect([await push(), await push()]).toEqual(["sent", "failed"]);
    expect(statuses.slice(3)).toEqual([201, 429]);
    expect(logged).toHaveLength(1);

    // A second outage is a new burst, logged once more.
    down = true;
    expect([await push(), await push()]).toEqual(["sent", "sent"]);
    expect(logged).toHaveLength(2);
  });

  test("the Worker reads the binding's answer as the limiter's, and runs without one", async () => {
    const asked: string[] = [];
    const limiter = limiterOf({
      TOKEN_LIMIT: { limit: async ({ key }) => (asked.push(key), { success: key === "ok" }) },
    });
    expect([await limiter?.allows("ok"), await limiter?.allows("spent")]).toEqual([true, false]);
    expect(asked).toEqual(["ok", "spent"]);
    expect(limiterOf({})).toBeUndefined();
  });
});
