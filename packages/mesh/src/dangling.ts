// The dangling pool (design section 3.3 steps 4-5): a record whose past, or whose signer's admission, has not arrived
// waits in a pool of at most MAX_DANGLING records, oldest dropped first, and joins the set when what it waits for lands.

import { door, missingFor, type RefusalReason } from "./door.ts";
import { cardOf, hashOf, parseRecord, verifyCard } from "./records/codec.ts";
import { MAX_DANGLING, type Signed } from "./records/types.ts";

export interface DoorMerge {
  /** The stored set with the admitted records appended, in the order they were admitted. */
  readonly stored: readonly Signed[];
  /** The records still held after the merge, oldest first, at most MAX_DANGLING. */
  readonly dangling: readonly Signed[];
  readonly added: readonly Signed[];
  readonly refused: readonly { readonly record: Signed; readonly reason: RefusalReason }[];
  /** Held records evicted by the cap, oldest first. */
  readonly dropped: readonly Signed[];
}

/** One delivery of a record: a copy with another signature is another delivery, so a forged copy never shadows the real one. */
const copy = (record: Signed): string => `${hashOf(record)} ${record.sig}`;

/** The signPub a stored found or admit lets sign: the subject of its card. */
function admittedKey(record: Signed): string | undefined {
  const body = parseRecord(record);
  if (body?.type !== "found" && body?.type !== "admit") return undefined;
  const card = cardOf(body);
  return card === undefined ? undefined : verifyCard(card)?.signPub;
}

/**
 * Runs `dangling` (older, first) and then `incoming` through the door against `stored`. An admitted record releases
 * every held record waiting for its hash or for the key it admits; held records stay in the pool in arrival order.
 */
export function mergeAtDoor(
  stored: readonly Signed[],
  dangling: readonly Signed[],
  incoming: readonly Signed[],
): DoorMerge {
  const set: Signed[] = [...stored];
  const seen = new Set(stored.map(copy));
  const held = new Map<string, { readonly record: Signed; readonly age: number }>();
  const waiting = new Map<string, string[]>();
  const added: Signed[] = [];
  const refused: { record: Signed; reason: RefusalReason }[] = [];
  const queue: { readonly record: Signed; readonly age: number }[] = [];
  let age = 0;
  for (const record of [...dangling, ...incoming]) {
    const key = copy(record);
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push({ record, age: age++ });
  }
  const wake = (key: string): void => {
    for (const hash of waiting.get(key) ?? []) {
      const entry = held.get(hash);
      if (entry === undefined) continue;
      held.delete(hash);
      queue.push(entry);
    }
    waiting.delete(key);
  };
  for (let next = 0; next < queue.length; next++) {
    const entry = queue[next];
    if (entry === undefined) break;
    const { record } = entry;
    const result = door(record, set);
    if (result.ok) {
      set.push(record);
      added.push(record);
      wake(`prev:${hashOf(record)}`);
      const key = admittedKey(record);
      if (key !== undefined) wake(`signer:${key}`);
    } else if (result.held) {
      const key =
        result.reason === "unknown signer" ? `signer:${parseRecord(record)?.by}` : `prev:${missingFor(record, set)[0]}`;
      held.set(hashOf(record), entry);
      waiting.set(key, [...(waiting.get(key) ?? []), hashOf(record)]);
    } else refused.push({ record, reason: result.reason });
  }
  const pool = [...held.values()].toSorted((a, b) => a.age - b.age).map((h) => h.record);
  const cut = Math.max(0, pool.length - MAX_DANGLING);
  return { stored: set, dangling: pool.slice(cut), added, refused, dropped: pool.slice(0, cut) };
}
