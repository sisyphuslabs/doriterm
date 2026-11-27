import { type Rec } from "./dag.ts";
import type { Engine } from "./engine.ts";
import type { RuleView } from "./membership.ts";

export function readmitAllowed(e: Engine, r: Rec, before: RuleView): boolean {
  const admission = (key: string): Rec | undefined => {
    const id = before.governing.get(key);
    return id === undefined ? undefined : e.dag.rec(id);
  };
  const p = r.readmit;
  if (p === undefined || r.subject === undefined || r.card === undefined) return false;
  const old = admission(p.old);
  if (old?.card?.kind !== "client" || admission(old.by)?.card?.kind !== "machine") return false;
  if (before.governing.has(r.subject) || before.revoked.includes(r.subject)) return false;
  if (
    [...before.governing].some(([key, id]) => {
      const card = e.dag.rec(id).card;
      return (before.rekeyed.get(key) ?? card?.noise) === r.card?.noise;
    })
  )
    return false;

  const otherClients = [...before.governing.keys()].filter(
    (key) => key !== p.old && admission(key)?.card?.kind === "client",
  );
  const approvedByOther = p.approver !== undefined && otherClients.includes(p.approver);
  if (!p.continuity) return approvedByOther;
  if (otherClients.length !== 0) return approvedByOther;
  return p.approver === undefined || p.approver === p.old;
}
