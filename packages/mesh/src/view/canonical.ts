import { hashOf, parseRecord } from "../records/codec.ts";
import type { Signed } from "../records/types.ts";

/** Kahn's topological order of `set`, smallest hash first among ready records; prev outside the set is ignored. */
export function canonicalOrder(set: readonly Signed[]): readonly Signed[] {
  const byHash = new Map(set.map((record) => [hashOf(record), record]));
  const waiting = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const [hash, record] of byHash) {
    const prev = (parseRecord(record)?.prev ?? []).filter((parent) => byHash.has(parent));
    waiting.set(hash, prev.length);
    for (const parent of prev) children.set(parent, [...(children.get(parent) ?? []), hash]);
  }
  const ready = [...waiting].filter(([, count]) => count === 0).map(([hash]) => hash);
  const order: Signed[] = [];
  while (ready.length > 0) {
    ready.sort();
    const hash = ready.shift();
    const record = hash === undefined ? undefined : byHash.get(hash);
    if (hash === undefined || record === undefined) break;
    order.push(record);
    for (const child of children.get(hash) ?? []) {
      const left = (waiting.get(child) ?? 1) - 1;
      waiting.set(child, left);
      if (left === 0) ready.push(child);
    }
  }
  return order;
}
