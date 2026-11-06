import { afterEach, describe, expect, test } from "bun:test";
import { pairEndpointUrl, pairOfferAnswer, requestPairOffer } from "../src/main/pair-offer.ts";
import type { LocalHostEndpoint } from "../src/shared/bridge.ts";

const token = "t".repeat(43);
const endpoint = (port: number): LocalHostEndpoint => ({ url: `ws://127.0.0.1:${port}/v1/hc`, token });

const OFFER = {
  code: "AB3K9XQZ",
  link: "doriface://pair#h=1&k=x",
  opens: "desktop",
  hostId: "h",
  fingerprint: "3FA9 4C0E",
  expiresAt: 1_800_000_000_000,
  slot: "registered",
  codeUsable: true,
} as const;

interface Stub {
  readonly server: ReturnType<typeof Bun.serve>;
  readonly seen: { method: string; path: string; authorization: string | null }[];
}

const stubs: Stub[] = [];
afterEach(() => {
  for (const stub of stubs.splice(0)) void stub.server.stop(true);
});

function hostAnswers(answer: () => Response): Stub {
  const seen: Stub["seen"] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      seen.push({
        method: request.method,
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
      });
      return answer();
    },
  });
  const stub = { server, seen };
  stubs.push(stub);
  return stub;
}

describe("asking this computer's host for its pairing offer", () => {
  test("the websocket endpoint names the plain-HTTP pair route", () => {
    expect(pairEndpointUrl({ url: "ws://127.0.0.1:52011/v1/hc", token })).toBe("http://127.0.0.1:52011/v1/pair");
    expect(pairEndpointUrl({ url: "wss://host.example/v1/hc", token })).toBe("https://host.example/v1/pair");
  });

  test("open posts, state reads, both with the host's per-launch token", async () => {
    const stub = hostAnswers(() => Response.json({ state: "pending", offer: OFFER }));
    const opened = await requestPairOffer(endpoint(stub.server.port ?? 0), "open");
    const state = await requestPairOffer(endpoint(stub.server.port ?? 0), "state");
    expect(opened).toEqual({ state: "pending", offer: OFFER });
    expect(state).toEqual({ state: "pending", offer: OFFER });
    expect(stub.seen).toEqual([
      { method: "POST", path: "/v1/pair", authorization: `Bearer ${token}` },
      { method: "GET", path: "/v1/pair", authorization: `Bearer ${token}` },
    ]);
  });

  test("a host too old for the route, one that refuses the token, and one that answers junk each say so", async () => {
    const old = hostAnswers(() => new Response("", { status: 404 }));
    expect(await requestPairOffer(endpoint(old.server.port ?? 0), "open")).toEqual({
      state: "unavailable",
      reason: "This doriface-host is too old to offer this computer.",
    });
    const refused = hostAnswers(() => new Response("", { status: 401 }));
    expect(await requestPairOffer(endpoint(refused.server.port ?? 0), "open")).toEqual({
      state: "unavailable",
      reason: "This computer's host refused the request; start it again.",
    });
    const junk = hostAnswers(() => Response.json({ state: "pending" }));
    expect(await requestPairOffer(endpoint(junk.server.port ?? 0), "open")).toEqual({
      state: "unavailable",
      reason: "This computer's host sent an answer this app does not understand.",
    });
  });

  test("a host that is not listening is an answer, not a throw", async () => {
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = closed.port ?? 0;
    await closed.stop(true);
    const answer = await requestPairOffer(endpoint(port), "state", 500);
    expect(answer.state).toBe("unavailable");
  });

  test("a slow host is cut off by the timeout instead of hanging the dialog", async () => {
    const stub = hostAnswers(() => new Response("never", { status: 200 }));
    const started = Date.now();
    const answer = await requestPairOffer(endpoint(stub.server.port ?? 0), "open", 50);
    expect(answer.state).toBe("unavailable");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("the answer is checked shape by shape before the page sees it", () => {
    expect(pairOfferAnswer({ state: "none" })).toEqual({ state: "none" });
    expect(pairOfferAnswer({ state: "paired", device: null })).toEqual({ state: "paired", device: null });
    expect(
      pairOfferAnswer({ state: "paired", device: { name: "phone", id: "3FA94C0E", pairedAt: "2026-01-01" } }),
    ).toEqual({ state: "paired", device: { name: "phone", id: "3FA94C0E", pairedAt: "2026-01-01" } });
    expect(pairOfferAnswer({ state: "pending", offer: OFFER })).toEqual({ state: "pending", offer: OFFER });
    const phoneLink = "https://app.doriterm.com/pair#h=1&k=x";
    expect(pairOfferAnswer({ state: "pending", offer: { ...OFFER, phoneLink } })).toEqual({
      state: "pending",
      offer: { ...OFFER, phoneLink },
    });
    for (const bad of [
      { state: "pending", offer: { ...OFFER, phoneLink: 7 } },
      null,
      {},
      { state: "pending" },
      { state: "pending", offer: { ...OFFER, expiresAt: "soon" } },
      { state: "pending", offer: { ...OFFER, slot: "maybe" } },
      { state: "pending", offer: { ...OFFER, opens: "phone" } },
      { state: "paired", device: { name: "phone" } },
    ]) {
      expect(pairOfferAnswer(bad)).toBeUndefined();
    }
  });
});
