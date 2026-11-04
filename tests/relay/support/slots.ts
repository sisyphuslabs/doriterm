import { CROCKFORD_ALPHABET } from "@doriface/relay-client";

const SLOT_COUNT = 32 ** 3;
const issued = new Set<string>();

/**
 * A random pairing slot no other caller in this run got. A registered slot outlives its host's uplink for its TTL,
 * so a slot shared between two tests could make one test's "not found" lookup find the other test's host.
 */
export function uniqueSlot(): string {
  if (issued.size >= SLOT_COUNT) throw new Error("every pairing slot was already handed out in this run");
  const slot = [...crypto.getRandomValues(new Uint8Array(3))].map((byte) => CROCKFORD_ALPHABET[byte % 32]).join("");
  if (issued.has(slot)) return uniqueSlot();
  issued.add(slot);
  return slot;
}

/** An offer expiry 10 minutes out, as a host signs it with its pairing slot (contract v1.8). */
export const offerExpiry = (): number => Date.now() + 10 * 60 * 1000;
