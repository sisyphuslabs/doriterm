import { checkName, idShaped } from "@doriface/crypto";

const FALLBACK = "browser";

/**
 * The browser's mesh name from its device name ("Chrome on macOS" becomes `chrome-on-macos`): herdr's machine-name
 * rule holds for every member card and for the pairing hello, where the host refuses anything else before the join
 * starts (`@doriface/crypto` payloads).
 */
export function meshNameOf(deviceName: string): string {
  const slug = deviceName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 32)
    .replace(/[^a-z0-9]+$/, "");
  if (slug === "" || idShaped(slug)) return FALLBACK;
  return checkName(slug) ? slug : FALLBACK;
}
