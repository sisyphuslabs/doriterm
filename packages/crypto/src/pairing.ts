import { base64urlDecode, base64urlEncode, concatBytes, utf8 } from "./encoding.ts";
import { hostIdOf } from "./identity.ts";

export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_RELAY_URL = "https://relay-doriface.omo.dev";
/** The hosted web app (#700, #747): the app lives on its own host; the apex domain is the product landing page. */
export const DEFAULT_PAIRING_WEB_ORIGIN = "https://app.doriterm.com";
/** Crockford base32: no I, L, O or U. */
export const PAIRING_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PAIRING_CODE_LENGTH = 8;
/** The leading characters that name the relay pairing slot; the rest is the secret. */
export const PAIRING_SLOT_LENGTH = 3;
/** Typed-code attempts the host answers per offer before it retires the code (contract v1.3 "Pairing"). */
export const PAIRING_CODE_ATTEMPTS = 10;
export const LINK_SECRET_LENGTH = 32;

/** 32 random bytes per pairing offer, carried only in the pairing URL fragment. */
export const generateLinkSecret = (): Uint8Array => crypto.getRandomValues(new Uint8Array(LINK_SECRET_LENGTH));

/** 8 Crockford base32 characters; each byte's low 5 bits pick one, so every character is uniform. */
export function generatePairingCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(PAIRING_CODE_LENGTH)), (byte) =>
    PAIRING_ALPHABET.charAt(byte & 31),
  ).join("");
}

/**
 * The canonical form of a typed code: uppercase, separators dropped, and Crockford's look-alikes mapped (O to 0,
 * I and L to 1). Throws unless 8 alphabet characters remain.
 */
export function normalizePairingCode(input: string): string {
  if (input.length > 4 * PAIRING_CODE_LENGTH) throw new Error("a pairing code is 8 characters");
  const code = input.toUpperCase().replaceAll(/[\s-]/g, "").replaceAll("O", "0").replaceAll(/[IL]/g, "1");
  if (code.length !== PAIRING_CODE_LENGTH || [...code].some((char) => !PAIRING_ALPHABET.includes(char))) {
    throw new Error(`a pairing code is ${PAIRING_CODE_LENGTH} characters of ${PAIRING_ALPHABET}`);
  }
  return code;
}

/** `XXXX XXXX`, the way people read and type it. */
export const formatPairingCode = (code: string): string => {
  const canonical = normalizePairingCode(code);
  return `${canonical.slice(0, 4)} ${canonical.slice(4)}`;
};

/** The relay pairing slot: the code's first 3 characters. */
export const pairingSlotOf = (code: string): string => normalizePairingCode(code).slice(0, PAIRING_SLOT_LENGTH);

export interface PairingOffer {
  readonly code: string;
  readonly linkSecret: Uint8Array;
  /** Milliseconds since the epoch. */
  readonly expiresAt: number;
}

export const createPairingOffer = (now = Date.now()): PairingOffer => ({
  code: generatePairingCode(),
  linkSecret: generateLinkSecret(),
  expiresAt: now + PAIRING_TTL_MS,
});

export type PairingGuardState = "open" | "used" | "expired";

/**
 * One offer's single-use lifecycle on the host: it ends only on the first confirmed handshake or at expiry, never on
 * failures, so nobody can burn an offer they cannot pair with. Claiming only reads the offer's secrets, so an attempt in
 * flight never locks another out; expiry is latched against a clock that later goes back.
 */
export class PairingGuard {
  readonly offer: PairingOffer;
  #state: PairingGuardState = "open";

  constructor(offer: PairingOffer) {
    this.offer = offer;
  }

  get state(): PairingGuardState {
    return this.#state;
  }

  claim(now = Date.now()): PairingOffer | undefined {
    this.#expireAt(now);
    return this.#state === "open" ? this.offer : undefined;
  }

  /**
   * A handshake with this code completed; true only for the first, which uses the code up, and only before expiry: a
   * handshake that started in time but finishes late does not pair.
   */
  use(now = Date.now()): boolean {
    this.#expireAt(now);
    if (this.#state !== "open") return false;
    this.#state = "used";
    return true;
  }

  #expireAt(now: number): void {
    if (this.#state === "open" && now >= this.offer.expiresAt) this.#state = "expired";
  }
}

/** PAIR_SLOT (uplink control frame 4) payload: the 3 ASCII slot characters, then the host's noiseStaticPub. */
export function encodePairSlot(slot: string, noiseStaticPub: Uint8Array): Uint8Array {
  const validSlot = slot.length === PAIRING_SLOT_LENGTH && [...slot].every((char) => PAIRING_ALPHABET.includes(char));
  if (!validSlot || noiseStaticPub.byteLength !== 32)
    throw new Error("PAIR_SLOT carries a 3-character slot and a 32-byte key");
  return concatBytes(utf8(slot), noiseStaticPub);
}

/** An empty PAIR_SLOT payload clears the host's slot. */
export const PAIR_SLOT_CLEAR = new Uint8Array(0);

/** What a pairing link carries besides where it opens: the fragment's five values, and `m=1` for a mesh offer. */
export interface PairingTarget {
  readonly hostId: string;
  readonly noiseStaticPub: Uint8Array;
  readonly signPub: Uint8Array;
  readonly linkSecret: Uint8Array;
  readonly relayUrl: string;
  /** A mesh offer (`&m=1`): the link admits a host into the mesh with `doriface-host mesh join`, not a device. */
  readonly mesh?: boolean | undefined;
}

/** A web pairing link: `<web origin>/pair#…`. */
export interface PairingLink extends PairingTarget {
  readonly webOrigin: string;
}

/** A parsed pairing link: the web app's when `webOrigin` is set, the desktop app's deep link when it is not. */
export interface ParsedPairingLink extends PairingTarget {
  readonly webOrigin?: string | undefined;
}

/** The desktop app's form of a pairing link: the web link's fragment under the app's own scheme. */
export const PAIRING_DEEP_LINK_PREFIX = "doriface://pair";

const WEBSOCKET_SCHEME: Readonly<Record<string, string>> = {
  "https:": "wss:",
  "wss:": "wss:",
  "http:": "ws:",
  "ws:": "ws:",
};

/** The relay as the web dials it: `wss://` for an https relay (`ws://` for http), keeping any path prefix. */
export function relayWebSocketUrl(relayUrl: string): string {
  if (!URL.canParse(relayUrl)) throw new Error(`the relay is not a URL: ${relayUrl}`);
  const url = new URL(relayUrl);
  const scheme = WEBSOCKET_SCHEME[url.protocol];
  if (scheme === undefined) throw new Error(`a relay URL is http(s) or ws(s), got ${url.protocol}`);
  return `${scheme}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/** The origin of the web app that opens pairing links; only an HTTP(S) URL has one. */
export function pairingWebOrigin(webOrigin: string): string {
  const url = URL.canParse(webOrigin) ? new URL(webOrigin) : undefined;
  if (url?.protocol !== "https:" && url?.protocol !== "http:") throw new Error("the web origin must be an HTTP(S) URL");
  return url.origin;
}

/** `<web origin>/pair#h=…&k=…&s=…&p=…&r=…`; everything sits in the fragment, which never reaches a server. */
export function buildPairingUrl(link: PairingLink): string {
  return `${pairingWebOrigin(link.webOrigin)}/pair#${pairingFragment(link)}`;
}

/** `doriface://pair#h=…&k=…&s=…&p=…&r=…`, the desktop app's form of the same link. */
export function buildPairingDeepLink(link: PairingTarget): string {
  return `${PAIRING_DEEP_LINK_PREFIX}#${pairingFragment(link)}`;
}

function pairingFragment(link: PairingTarget): string {
  return new URLSearchParams({
    h: link.hostId,
    k: base64urlEncode(link.noiseStaticPub),
    s: base64urlEncode(link.signPub),
    p: base64urlEncode(link.linkSecret),
    r: relayWebSocketUrl(link.relayUrl),
    ...(link.mesh === true ? { m: "1" } : {}),
  }).toString();
}

function isPairingDeepLink(url: URL): boolean {
  return (
    url.protocol === "doriface:" &&
    url.host.toLowerCase() === "pair" &&
    (url.pathname === "" || url.pathname === "/") &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    url.search === ""
  );
}

/** Parses either form of a pairing link: a web page's `<origin>/pair#…` or the desktop app's `doriface://pair#…`. */
export function parsePairingLink(url: string): ParsedPairingLink {
  const parsed = new URL(url);
  const deep = parsed.protocol === "doriface:";
  if (deep && !isPairingDeepLink(parsed)) throw new Error("a pairing deep link is doriface://pair#…");
  if (!deep) pairingWebOrigin(url);
  const fragment = new URLSearchParams(parsed.hash.slice(1));
  const get = (key: string): string => {
    const value = fragment.get(key);
    if (value === null || value === "") throw new Error(`the pairing URL lacks ${key}=`);
    return value;
  };
  const key = (name: string): Uint8Array => {
    const encoded = get(name);
    if (encoded.length !== 43) throw new Error("the pairing URL has a bad key");
    return base64urlDecode(encoded);
  };
  if (!fragment.has("p") && fragment.has("c")) {
    throw new Error("this pairing link comes from an older doriface-host; run doriface-host pair again");
  }
  const noiseStaticPub = key("k");
  const signPub = key("s");
  const hostId = get("h");
  if (hostIdOf(signPub) !== hostId) throw new Error("the pairing URL's hostId does not match its signing key");
  const linkSecret = key("p");
  const relayUrl = relayWebSocketUrl(get("r"));
  return {
    ...(deep ? {} : { webOrigin: parsed.origin }),
    hostId,
    noiseStaticPub,
    signPub,
    linkSecret,
    relayUrl,
    mesh: fragment.get("m") === "1",
  };
}

/** Parses a web pairing link; the desktop app's deep link is refused, as it has no web origin. */
export function parsePairingUrl(url: string): PairingLink {
  const link = parsePairingLink(url);
  if (link.webOrigin === undefined) throw new Error("the pairing URL is a doriface:// deep link, not a web page");
  return { ...link, webOrigin: link.webOrigin };
}
