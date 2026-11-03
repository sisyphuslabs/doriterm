import { hashOf, parseRecord, type Signed } from "@doriface/mesh";

/**
 * The stored records outside the past of `peerHeads` (section 5.2), in stored order, which the door keeps
 * topological. Heads this host does not hold are ignored: they say nothing about what the peer lacks here.
 */
export function missingSince(records: readonly Signed[], peerHeads: Iterable<string>): readonly Signed[] {
  const prevOf = new Map(records.map((record) => [hashOf(record), parseRecord(record)?.prev ?? []]));
  const past = new Set<string>();
  const stack = [...peerHeads].filter((hash) => prevOf.has(hash));
  for (let hash = stack.pop(); hash !== undefined; hash = stack.pop()) {
    if (past.has(hash)) continue;
    past.add(hash);
    stack.push(...(prevOf.get(hash) ?? []));
  }
  return records.filter((record) => !past.has(hashOf(record)));
}

/** The highest counter of each signer in `records`: a `hello`'s `n` (section 5.2). */
export function countersOf(records: readonly Signed[]): Record<string, number> {
  const n: Record<string, number> = {};
  for (const record of records) {
    const body = parseRecord(record);
    if (body !== undefined) n[body.by] = Math.max(n[body.by] ?? 0, body.n);
  }
  return n;
}
