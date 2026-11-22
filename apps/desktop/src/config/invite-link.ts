import { buildPairingDeepLink, PAIRING_DEEP_LINK_PREFIX, parsePairingLink } from "@doriface/crypto";

/** Far above a real invite link (about 250 characters); longer clipboard text is not one and is not parsed. */
const MAX_INVITE_LENGTH = 2048;
const INVITE_KEYS = ["h", "k", "s", "p", "r"];

/** Exactly the five pairing values once each, and `m=1` at most: a stray key or a changed flag is not an invite. */
function exactKeys(hash: string): boolean {
  const params = new URLSearchParams(hash.slice(1));
  const keys = [...params.keys()];
  const expected = params.has("m") ? [...INVITE_KEYS, "m"] : INVITE_KEYS;
  const flag = params.get("m");
  return (
    (flag === null || flag === "1") && keys.length === expected.length && expected.every((key) => keys.includes(key))
  );
}

/**
 * The DoriTerm invite link in clipboard text, or undefined for anything else (#2656). Only the two forms the pairing
 * spec defines count, `<web origin>/pair#…` and `doriface://pair#…`, and only with a fragment the spec's own parser
 * takes (key lengths, hostId bound to the signing key, a ws(s) relay). What comes back is rebuilt from the parsed
 * values as `doriface://pair#…`, so no clipboard bytes beyond the invite ever reach the renderer.
 */
export function inviteLink(text: string): string | undefined {
  const candidate = text.trim();
  if (candidate.length > MAX_INVITE_LENGTH || /\s/.test(candidate)) return undefined;
  const url = URL.parse(candidate);
  if (url === null || url.username !== "" || url.password !== "" || url.search !== "") return undefined;
  const web = (url.protocol === "https:" || url.protocol === "http:") && url.pathname === "/pair";
  const deep = url.protocol === "doriface:" && url.host === "pair" && (url.pathname === "" || url.pathname === "/");
  if ((!web && !deep) || !exactKeys(url.hash)) return undefined;
  try {
    return buildPairingDeepLink(parsePairingLink(`${PAIRING_DEEP_LINK_PREFIX}${url.hash}`));
  } catch {
    return undefined;
  }
}
