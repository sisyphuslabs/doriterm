import { hashOf, parseRecord } from "../records/codec.ts";
import type { Signed } from "../records/types.ts";
import { kahn } from "./dag.ts";

/** Kahn's topological order of `set`, smallest hash first among ready records; prev outside the set is ignored. */
export function canonicalOrder(set: readonly Signed[]): readonly Signed[] {
  const byHash = new Map(set.map((record) => [hashOf(record), record]));
  const parents = new Map(
    [...byHash].map(([hash, record]) => [hash, (parseRecord(record)?.prev ?? []).filter((p) => byHash.has(p))]),
  );
  return kahn(parents).flatMap((hash) => byHash.get(hash) ?? []);
}
