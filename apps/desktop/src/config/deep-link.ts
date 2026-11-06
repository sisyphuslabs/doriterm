import { buildPairingUrl, parsePairingUrl } from "@doriface/crypto";

export const DEEP_LINK_SCHEME = "doriface";

/** The web app whose pairing links (`<origin>/pair#…`, docs/transport.md "Pairing") the desktop app opens itself. */
export const PAIRING_WEB_ORIGIN = "https://app.doriterm.com";

/**
 * Origins whose pairing page this build keeps in the app. The previous host is still live while the app moves, so a
 * link a member printed before the move keeps opening here; it drops out when that host redirects to the new one.
 */
export const PAIRING_WEB_ORIGINS: readonly string[] = [PAIRING_WEB_ORIGIN, "https://doriface.omo.dev"];

export type DeepLink = { readonly kind: "open" } | { readonly kind: "pair"; readonly fragment: string };

/** Far above a real pairing link (about 250 characters) and far below what a URL parser should be fed. */
const MAX_LINK_LENGTH = 2048;
const PAIRING_KEYS = ["h", "k", "s", "p", "r"] as const;

/**
 * Checks a pairing fragment against the link spec through the spec's own parser (key lengths, hostId bound to the
 * signing key, a ws(s) relay), with exactly the five keys once each, and rebuilds it. Only the rebuilt string ever
 * reaches the renderer, never the bytes that came in.
 */
function canonicalFragment(hash: string): string | undefined {
  const params = new URLSearchParams(hash.slice(1));
  const keys = [...params.keys()];
  if (keys.length !== PAIRING_KEYS.length || !PAIRING_KEYS.every((key) => keys.includes(key))) return undefined;
  try {
    const link = parsePairingUrl(`${PAIRING_WEB_ORIGIN}/pair${hash}`);
    const url = buildPairingUrl(link);
    return url.slice(url.indexOf("#"));
  } catch {
    return undefined;
  }
}

function parseBounded(candidate: unknown): URL | undefined {
  if (typeof candidate !== "string" || candidate.length > MAX_LINK_LENGTH) return undefined;
  const url = URL.parse(candidate);
  if (url === null || url.username !== "" || url.password !== "" || url.port !== "" || url.search !== "") {
    return undefined;
  }
  return url;
}

/**
 * A `doriface:` link from the OS, which anyone on the machine (or any web page that offers one) can hand over, so it
 * is read against an allowlist: `doriface://` brings the window forward, `doriface://pair#<pairing link fragment>`
 * opens the pairing step on that link. Everything else is refused.
 */
export function parseDeepLink(candidate: unknown): DeepLink | undefined {
  const url = parseBounded(candidate);
  if (url?.protocol !== `${DEEP_LINK_SCHEME}:` || (url.pathname !== "" && url.pathname !== "/")) return undefined;
  if (url.host === "" && url.hash === "") return { kind: "open" };
  if (url.host !== "pair") return undefined;
  const fragment = canonicalFragment(url.hash);
  return fragment === undefined ? undefined : { kind: "pair", fragment };
}

/** A link clicked inside the app: only the web app's own pairing link stays in the app. */
export function parseInAppLink(candidate: unknown): DeepLink | undefined {
  const url = parseBounded(candidate);
  if (url === undefined || !PAIRING_WEB_ORIGINS.includes(url.origin) || url.pathname !== "/pair") return undefined;
  const fragment = canonicalFragment(url.hash);
  return fragment === undefined ? undefined : { kind: "pair", fragment };
}

/** The `doriface:` argument of a launch (Windows and Linux pass the link in argv), unless there is not exactly one. */
export function deepLinkArg(argv: readonly string[]): string | undefined {
  const links = argv.filter((arg) => arg.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}:`));
  return links.length === 1 ? links[0] : undefined;
}
