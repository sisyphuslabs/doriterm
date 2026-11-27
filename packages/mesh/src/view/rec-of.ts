// From stored signed records to the abstract records the engine evaluates. The door has already checked signatures
// and cards; a record that no longer parses is left out, and so is every record whose past is not complete.

import { hashOf, memberCardOf, parseRecord } from "../records/codec.ts";
import type { Signed } from "../records/types.ts";
import type { Card, Rec } from "./dag.ts";

/**
 * Each stored record's abstract form, parsed once: a stored record is immutable, so a merge parses, hashes and
 * verifies only the records it adds. Keeping the same objects also lets the engine carry its per-record results over.
 */
const parsed = new WeakMap<Signed, Rec | null>();

function recOf(record: Signed): Rec | undefined {
  const known = parsed.get(record);
  if (known !== undefined) return known ?? undefined;
  const r = parse(record);
  parsed.set(record, r ?? null);
  return r;
}

function parse(record: Signed): Rec | undefined {
  const body = parseRecord(record);
  if (body === undefined) return undefined;
  const base = { id: hashOf(record), type: body.type, by: body.by, n: body.n, prev: body.prev };
  const subject = body.subject;
  if (subject === undefined) return base;
  if (body.type === "readmit" || "card" in subject) {
    const c = memberCardOf(body);
    if (c === undefined) return undefined;
    const card: Card = {
      by: c.signPub,
      hostId: c.hostId,
      inviter: c.inviter,
      noise: c.noisePub,
      name: c.name,
      nonce: c.nonce,
      kind: c.kind,
    };
    const readmit =
      body.type === "readmit"
        ? {
            old: body.subject.old,
            at: body.subject.at,
            continuity: body.subject.oldSig !== undefined,
            approver: body.subject.approval?.by,
          }
        : undefined;
    return { ...base, subject: c.signPub, card, ...(readmit === undefined ? {} : { readmit }) };
  }
  if ("signPubs" in subject) return { ...base, subjects: subject.signPubs, reason: subject.reason };
  return "name" in subject ? { ...base, subject: subject.signPub, name: subject.name } : undefined;
}

/** The past-closed records of `set` reachable from its one found record; undefined without exactly one found. */
export function recordsOf(set: readonly Signed[]): readonly Rec[] | undefined {
  const byId = new Map<string, Rec>();
  for (const record of set) {
    const r = recOf(record);
    if (r !== undefined) byId.set(r.id, r);
  }
  if ([...byId.values()].filter((r) => r.type === "found").length !== 1) return undefined;
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, r] of byId) {
      if (r.prev.every((p) => byId.has(p))) continue;
      byId.delete(id);
      changed = true;
    }
  }
  return [...byId.values()];
}
