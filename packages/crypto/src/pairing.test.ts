import { describe, expect, test } from "bun:test";
import { generateHostIdentity } from "./identity.ts";
import {
  buildPairingDeepLink,
  buildPairingUrl,
  createPairingOffer,
  DEFAULT_RELAY_URL,
  encodePairSlot,
  formatPairingCode,
  normalizePairingCode,
  PAIR_SLOT_CLEAR,
  PAIRING_ALPHABET,
  PAIRING_TTL_MS,
  pairingSlotOf,
  PairingGuard,
  parsePairingLink,
  parsePairingUrl,
} from "./pairing.ts";

const identity = generateHostIdentity();

describe("pairing code", () => {
  test("is 8 Crockford base32 characters, a 3-character slot then the secret, expiring after 10 minutes", () => {
    const offer = createPairingOffer(1_000);
    expect(offer.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(pairingSlotOf(offer.code)).toBe(offer.code.slice(0, 3));
    expect(formatPairingCode(offer.code)).toBe(`${offer.code.slice(0, 4)} ${offer.code.slice(4)}`);
    expect(offer.expiresAt).toBe(1_000 + PAIRING_TTL_MS);
  });

  test("draws every alphabet character", () => {
    const seen = new Set(Array.from({ length: 200 }, () => createPairingOffer().code).join(""));
    expect([...seen].toSorted().join("")).toBe(PAIRING_ALPHABET);
  });

  test("an offer carries a fresh 32-byte link secret", () => {
    const [a, b] = [createPairingOffer(), createPairingOffer()];
    expect(a.linkSecret.byteLength).toBe(32);
    expect(a.linkSecret).not.toEqual(b.linkSecret);
  });

  test.each([
    ["3fa9 4c0e", "3FA94C0E"],
    ["3FA9-4C0E", "3FA94C0E"],
    ["oil1 abcd", "0111ABCD"],
  ])("a typed %p reads as %p", (typed, code) => {
    expect(normalizePairingCode(typed)).toBe(code);
  });

  test.each(["", "ABC", "ABCDEFGHJ", "ABCD EFGU", "ABCD!EFG"])("rejects code %p", (bad) => {
    expect(() => normalizePairingCode(bad)).toThrow();
  });
});

describe("PairingGuard", () => {
  test("an attempt in flight does not lock others out; the first success uses the code up", () => {
    const guard = new PairingGuard(createPairingOffer(0));
    expect(guard.claim(1)).toBe(guard.offer);
    expect(guard.claim(1)).toBe(guard.offer);
    expect(guard.use(1)).toBe(true);
    expect(guard.use(1)).toBe(false);
    expect([guard.state, guard.claim(1)]).toEqual(["used", undefined]);
  });

  test("failed attempts never end the code: only a success or expiry does", () => {
    const guard = new PairingGuard(createPairingOffer(0));
    for (let attempt = 0; attempt < 20; attempt++) expect(guard.claim(1)).toBe(guard.offer);
    expect(guard.state).toBe("open");
  });

  test("a handshake that completes after expiry does not use the code", () => {
    const guard = new PairingGuard(createPairingOffer(0));
    expect(guard.claim(1)).toBeDefined();
    expect(guard.use(PAIRING_TTL_MS)).toBe(false);
    expect(guard.state).toBe("expired");
  });

  test("never yields after expiry, even if the clock later goes back", () => {
    const guard = new PairingGuard(createPairingOffer(0));
    expect(guard.claim(PAIRING_TTL_MS)).toBeUndefined();
    expect([guard.state, guard.claim(1)]).toEqual(["expired", undefined]);
  });
});

const fragment = (from: string): URLSearchParams => new URLSearchParams(new URL(from).hash.slice(1));

describe("pairing URL", () => {
  const link = {
    webOrigin: "https://app.doriterm.com/",
    hostId: identity.hostId,
    noiseStaticPub: identity.noise.publicKey,
    signPub: identity.sign.publicKey,
    linkSecret: createPairingOffer().linkSecret,
    relayUrl: DEFAULT_RELAY_URL,
  };
  const url = buildPairingUrl(link);

  test("puts everything in the fragment and parses back", () => {
    expect(url.startsWith(`https://app.doriterm.com/pair#h=${identity.hostId}&k=`)).toBe(true);
    expect(new URL(url).search).toBe("");
    expect(parsePairingUrl(url)).toEqual({
      ...link,
      webOrigin: "https://app.doriterm.com",
      relayUrl: "wss://relay-doriface.omo.dev",
      mesh: false,
    });
  });

  test("a mesh offer's link carries m=1 and parses back as a mesh link", () => {
    const meshUrl = buildPairingUrl({ ...link, mesh: true });
    expect(fragment(meshUrl).get("m")).toBe("1");
    expect(parsePairingUrl(meshUrl).mesh).toBe(true);
    expect(fragment(url).has("m")).toBe(false);
  });

  test("carries the link secret as 43 base64url characters and never the typed code", () => {
    expect(fragment(url).get("p")).toHaveLength(43);
    expect(fragment(url).has("c")).toBe(false);
  });

  test("a link with a code and no link secret comes from an older host", () => {
    const old = url.replace(/p=[^&]+/, "c=7KQ39D2M");
    expect(() => parsePairingUrl(old)).toThrow("older doriface-host");
  });

  test.each([
    ["https://relay-doriface.omo.dev", "wss://relay-doriface.omo.dev"],
    ["https://relay.example:8443/doriface/", "wss://relay.example:8443/doriface"],
    ["http://127.0.0.1:8787", "ws://127.0.0.1:8787"],
    ["wss://relay.example", "wss://relay.example"],
  ])("carries relay %p as the WebSocket URL %p", (relayUrl, expected) => {
    expect(new URLSearchParams(new URL(buildPairingUrl({ ...link, relayUrl })).hash.slice(1)).get("r")).toBe(expected);
  });

  test.each(["ftp://relay.example", "file:///relay", "relay"])("refuses relay %p", (relayUrl) => {
    expect(() => buildPairingUrl({ ...link, relayUrl })).toThrow();
  });

  test.each([
    ["a hostId of another key", url.replace(identity.hostId, generateHostIdentity().hostId)],
    ["a missing link secret", url.replace(/&p=[^&]+/, "")],
    ["a 42-character link secret", url.replace(/p=[^&]+/, `p=${"A".repeat(42)}`)],
    ["a 44-character link secret", url.replace(/p=[^&]+/, `p=${"A".repeat(44)}`)],
    ["a short key", url.replace(/k=[^&]+/, "k=AAAA")],
    ["a relay that is not a URL", url.replace(/r=[^&]+$/, "r=relay")],
    ["an oversized key", url.replace(/k=[^&]+/, `k=${"A".repeat(100_000)}`)],
    ["a non-HTTP(S) page", url.replace("https://app.doriterm.com", "file://")],
  ])("rejects %s", (_, bad) => {
    expect(() => parsePairingUrl(bad)).toThrow();
  });
});

describe("pairing deep link", () => {
  const link = {
    hostId: identity.hostId,
    noiseStaticPub: identity.noise.publicKey,
    signPub: identity.sign.publicKey,
    linkSecret: createPairingOffer().linkSecret,
    relayUrl: DEFAULT_RELAY_URL,
  };

  test("carries the same five-key fragment under doriface://pair and parses back without a web origin", () => {
    const deepLink = buildPairingDeepLink(link);
    expect(deepLink.startsWith(`doriface://pair#h=${identity.hostId}&k=`)).toBe(true);
    expect([...fragment(deepLink).keys()]).toEqual(["h", "k", "s", "p", "r"]);
    expect(parsePairingLink(deepLink)).toEqual({
      ...link,
      relayUrl: "wss://relay-doriface.omo.dev",
      mesh: false,
    });
  });

  test("a mesh deep link carries m=1, and a web-only parser still refuses it", () => {
    const deepLink = buildPairingDeepLink({ ...link, mesh: true });
    expect(fragment(deepLink).get("m")).toBe("1");
    expect(parsePairingLink(deepLink).mesh).toBe(true);
    expect(() => parsePairingUrl(deepLink)).toThrow();
  });

  test.each(["doriface://pair/x#h=1", "doriface://elsewhere#h=1"])(
    "a deep link of another shape is refused: %p",
    (other) => {
      expect(() => parsePairingLink(other)).toThrow();
    },
  );
});

describe("pairing URL origins", () => {
  test.each(["file:///tmp/x", "data:text/plain,x", "javascript:alert(1)"])("refuses web origin %p", (webOrigin) => {
    const identity2 = generateHostIdentity();
    const build = () =>
      buildPairingUrl({
        webOrigin,
        hostId: identity2.hostId,
        noiseStaticPub: identity2.noise.publicKey,
        signPub: identity2.sign.publicKey,
        linkSecret: createPairingOffer().linkSecret,
        relayUrl: DEFAULT_RELAY_URL,
      });
    expect(build).toThrow("HTTP(S)");
  });
});

describe("PAIR_SLOT payload", () => {
  test("is the 3 ASCII slot characters then the 32-byte noiseStaticPub; empty clears", () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const payload = encodePairSlot("Q7M", key);
    expect(payload.byteLength).toBe(35);
    expect(new TextDecoder().decode(payload.subarray(0, 3))).toBe("Q7M");
    expect(payload.subarray(3)).toEqual(key);
    expect(PAIR_SLOT_CLEAR.byteLength).toBe(0);
  });

  test.each([
    ["Q7", 32],
    ["Q7U", 32],
    ["Q7M", 31],
  ])("refuses slot %p with a %p-byte key", (slot, size) => {
    expect(() => encodePairSlot(slot, new Uint8Array(size))).toThrow();
  });
});
