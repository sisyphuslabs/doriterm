import { type Signed, type View, type ViewCache, witnessPool } from "@doriface/mesh";

// The revoke-time witness pool around `witnessPool` of packages/mesh (design section 6.1): which subjects a revoke
// written by this host leaves undecidable, and who could write it instead. One `cache` per call shares the views.

/** Per subject with an empty pool from `self`, the current members whose position has a non-empty one. */
export function undecidableFrom(
  records: readonly Signed[],
  view: View,
  self: string,
  subjects: readonly string[],
  cache: ViewCache,
  /** The members that may witness: machines. A client never dials and never votes (design of #942, section 8). */
  mayWitness?: ReadonlySet<string> | undefined,
): ReadonlyMap<string, readonly string[]> {
  const own = witnessPool(records, self, subjects, cache);
  const empty = subjects.filter((subject) => (own.get(subject) ?? []).length === 0);
  if (empty.length === 0) return new Map();
  const candidates = [...view.members].filter(
    (key) => key !== self && !subjects.includes(key) && (mayWitness === undefined || mayWitness.has(key)),
  );
  const pools = candidates.map((key) => [key, witnessPool(records, key, subjects, cache)] as const);
  return new Map(
    empty.map((subject) => [
      subject,
      pools.filter(([, pool]) => (pool.get(subject) ?? []).length > 0).map(([key]) => key),
    ]),
  );
}

/** The pool for one subject from `self`, and the member to ask when it is empty (`mesh status`'s witnessPool). */
export function witnessFacts(
  records: readonly Signed[],
  view: View,
  self: string,
  subject: string,
  cache: ViewCache,
): { readonly pool: readonly string[]; readonly ask: string | null } {
  const pool = witnessPool(records, self, [subject], cache).get(subject) ?? [];
  if (pool.length > 0) return { pool, ask: null };
  return { pool, ask: undecidableFrom(records, view, self, [subject], cache).get(subject)?.[0] ?? null };
}
