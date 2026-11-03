// Section 3.2's own chain across a prev fold: a record by this host is valid only if its own previous record is in
// its past, so every fold ack must name a head that covers this host's latest record. After the first fold that head
// is the fold ack itself, which keeps the chain whole and lets the next folds take the heads not named yet.
import { hashOf, parseRecord, type Signed } from "@doriface/mesh";

function latestOwn(records: readonly Signed[], self: string): string | undefined {
  let latest: { readonly hash: string; readonly n: number } | undefined;
  for (const record of records) {
    const body = parseRecord(record);
    if (body?.by === self && (latest === undefined || body.n > latest.n)) latest = { hash: hashOf(record), n: body.n };
  }
  return latest?.hash;
}

/** The records whose past holds `root`, `root` included. */
function descendants(records: readonly Signed[], root: string): ReadonlySet<string> {
  const children = new Map<string, string[]>();
  for (const record of records) {
    const hash = hashOf(record);
    for (const prev of parseRecord(record)?.prev ?? []) {
      const list = children.get(prev);
      if (list === undefined) children.set(prev, [hash]);
      else list.push(hash);
    }
  }
  const found = new Set([root]);
  const queue = [root];
  for (const hash of queue) {
    for (const child of children.get(hash) ?? []) {
      if (found.has(child)) continue;
      found.add(child);
      queue.push(child);
    }
  }
  return found;
}

/** `heads` in fold order: the head covering this host's latest own record first, then the rest as stored. */
export function ownHeadFirst(records: readonly Signed[], heads: readonly string[], self: string): readonly string[] {
  const own = latestOwn(records, self);
  if (own === undefined) return heads;
  const covered = descendants(records, own);
  const covering = heads.find((head) => covered.has(head));
  return covering === undefined ? heads : [covering, ...heads.filter((head) => head !== covering)];
}
