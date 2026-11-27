// R3 "status": a record's own verdict at level 1, then its status in canonical order, with authority propagated from
// its signer's admission (revokes: through the whole lineage, hop by hop).

import { type RecordSet, subjectsOf } from "./dag.ts";
import type { Engine } from "./engine.ts";
import { accusers, accusers0 } from "./standing.ts";
import { valid } from "./structure.ts";
import { verdict } from "./testimony.ts";

export type Own = "invalid" | "defeated" | "tie" | "clear";
export type Status = "eff" | "tie" | "void" | "restore-conflict";

/**
 * own(x): invalid, defeated by a standing accuser, tie (some standing accuser ties it 0:0), or clear. Without a
 * concurrent revoke of its signer in S, own(x) is valid(x) alone, which is the same in every set.
 */
export function own(e: Engine, S: RecordSet, id: string): Own {
  if (id === e.dag.found.id) return "clear";
  if (!valid(e, id)) return "invalid";
  if (accusers0(e, S, id).length === 0) return "clear";
  return e.cached(S, "own", id, (): Own => {
    let tie = false;
    for (const v of accusers(e, S, id)) {
      const vd = verdict(e, S, v, id, 1, accusers);
      if (vd === "defeated") return "defeated";
      if (vd === "tie") tie = true;
    }
    return tie ? "tie" : "clear";
  });
}

/**
 * A revoke keeps its authority unless an admission on its signer's lineage is invalid or defeated: each hop looks the
 * signer up in the view of the previous admission's own past, all the way to the found record. That view is of a
 * strictly smaller set at every hop, so the walk ends with no bound; each admission's answer is memoized for S, so
 * the walks of all revokes together visit each admission once.
 */
function revokeAuthority(e: Engine, S: RecordSet, id: string): boolean {
  const memo = e.cached(S, "authority", "", () => new Map<string, boolean>());
  const walked: string[] = [];
  let gov = e.before(id)?.governing.get(e.dag.rec(id).by);
  let result: boolean | undefined;
  while (result === undefined) {
    if (gov === undefined) result = false;
    else if (memo.has(gov)) result = memo.get(gov);
    else if (gov === e.dag.found.id) result = true;
    else {
      walked.push(gov);
      const g = own(e, S, gov);
      if (g === "invalid" || g === "defeated") result = false;
      else gov = e.before(gov)?.governing.get(e.dag.rec(gov).by);
    }
  }
  for (const g of walked) memo.set(g, result);
  return result;
}

/** A conflict removes the old identity without granting any of the competing successors authority. */
function restoreConflict(e: Engine, S: RecordSet, id: string): boolean {
  const r = e.dag.rec(id);
  const old = r.readmit?.old;
  if (old === undefined) return false;
  const candidates = e.cached(S, "restore candidates", old, () =>
    e.dag.index.relevant.filter((other) => {
      if (!S.has(other)) return false;
      const candidate = e.dag.rec(other);
      if (candidate.readmit?.old === old) return own(e, S, other) === "clear";
      return (
        candidate.type === "revoke" &&
        candidate.reason !== "leave" &&
        subjectsOf(candidate).includes(old) &&
        own(e, S, other) !== "invalid" &&
        own(e, S, other) !== "defeated" &&
        revokeAuthority(e, S, other)
      );
    }),
  );
  return candidates.some((other) => {
    if (!e.dag.conc(id, other)) return false;
    const candidate = e.dag.rec(other);
    return candidate.type === "revoke" || candidate.subject !== r.subject || candidate.card?.noise !== r.card?.noise;
  });
}

/** status(x), with `done` holding the status of every record before x in canonical order (all its ancestors). */
export function status(e: Engine, S: RecordSet, id: string, done: ReadonlyMap<string, Status>): Status {
  if (id === e.dag.found.id) return "eff";
  const mine = own(e, S, id);
  if (mine === "invalid" || mine === "defeated") return "void";
  const r = e.dag.rec(id);
  if (r.type === "revoke") {
    if (!revokeAuthority(e, S, id)) return "void";
  } else {
    const gov = e.before(id)?.governing.get(r.by);
    if (gov === undefined || done.get(gov) !== "eff") return "void";
  }
  if (mine === "tie") return "tie";
  return r.type === "readmit" && restoreConflict(e, S, id) ? "restore-conflict" : "eff";
}
