// Arbitrary record DAGs for the differential fuzz: any signer writes any record type with prev drawn from the whole
// past, and some counters are wrong on purpose (reused, skipped, zero, fractional), so the structure rules (own chain,
// pred, forks) see equivocations and gaps the honest generators never make. Duplicate prev entries appear too.

import type { Rec } from "../../src/view/dag.ts";
import { pick, type Rng } from "../sim/world.ts";
import { ack, admit, type Draft, name, rekey, revoke, withChainNumbers } from "./records.ts";

const KEYS = ["A", "B", "C", "D", "E", "G"];

function draftOf(r: Rng, id: string, by: string, prev: readonly string[]): Draft {
  const roll = r.next();
  if (roll < 0.25) return admit(id, by, pick(r, KEYS), prev, r.next() < 0.2 ? `${id}-key` : undefined);
  if (roll < 0.45) {
    const subjects = KEYS.filter(() => r.next() < 0.3);
    return revoke(id, by, subjects.length > 0 ? subjects : [pick(r, KEYS)], prev);
  }
  if (roll < 0.6) return name(id, by, pick(r, KEYS), prev, `${id}-name`);
  if (roll < 0.7) return rekey(id, by, prev, `${id}-noise`);
  return ack(id, by, prev);
}

const WRONG_COUNTERS: readonly ((n: number) => number)[] = [(n) => n - 1, (n) => n + 1, () => 0, (n) => n - 0.5];

export function randomDag(r: Rng, size: number): Rec[] {
  const drafts: Draft[] = [{ ...admit("f0", "A", "A", []), type: "found" }];
  for (let i = 1; i < size; i++) {
    const ids = drafts.map((d) => d.id);
    const recent = ids.slice(-6);
    const prev = Array.from({ length: 1 + Math.floor(r.next() * 3) }, () => pick(r, r.next() < 0.7 ? recent : ids));
    drafts.push(
      draftOf(r, `x${String(i).padStart(3, "0")}`, pick(r, KEYS), r.next() < 0.9 ? [...new Set(prev)] : prev),
    );
  }
  const out: Rec[] = [];
  for (const rec of withChainNumbers(drafts))
    out.push(rec.type !== "found" && r.next() < 0.12 ? { ...rec, n: pick(r, WRONG_COUNTERS)(rec.n) } : rec);
  return out;
}
