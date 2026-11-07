// membership(S, eff) of contract v1.5 "Membership": from the effective records of S to the view (members,
// revoked keys, Noise keys, admitter lineage, names). It reads every record type but ack, so the engine decides only
// those statuses before calling it, and the view it returns has no `eff`: a caller that needs eff adds it.

import { fallbacks } from "../names.ts";
import { type Dag, isAdmission, type Rec, type RecordSet, subjectsOf } from "./dag.ts";
import type { Status } from "./status.ts";

/** The view the rules read: everything membership() decides, without the set's effective records. */
export interface MemberView {
  /** Every key with a governing admission, in the canonical order of those admissions. A mesh has no member cap. */
  readonly members: readonly string[];
  readonly revoked: readonly string[];
  readonly noise: ReadonlyMap<string, string>;
  /** signPub -> its Noise key, for the members whose key a rekey changed: the rest hold their governing card's. */
  readonly rekeyed: ReadonlyMap<string, string>;
  readonly admitter: ReadonlyMap<string, string>;
  readonly governing: ReadonlyMap<string, string>;
  readonly name: ReadonlyMap<string, string>;
  readonly hostId: ReadonlyMap<string, string>;
}

/**
 * What the rules read of a view: revoked keys, every member's governing admission (its keys are the members, in member
 * order) and the Noise keys a rekey changed. A ViewCache keeps one of these per record and per context, so it holds one
 * entry per member and leaves out what the governing card already says (the member list, the other Noise keys) and
 * what only the full view reports (admitter, names, hostIds).
 */
export type RuleView = Pick<MemberView, "revoked" | "governing" | "rekeyed">;

export const ruleViewOf = (v: MemberView): RuleView => ({
  revoked: v.revoked,
  governing: v.governing,
  rekeyed: v.rekeyed,
});

export interface EngineView extends MemberView {
  readonly eff: ReadonlySet<string>;
}

/** The maximal records of a list in canonical order (none of the others has it in its past); ties by smallest id. */
function latest(dag: Dag, recs: readonly Rec[]): Rec | undefined {
  const maximal: Rec[] = [];
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i];
    if (r !== undefined && !maximal.some((m) => dag.inPast(m.id, r.id))) maximal.push(r);
  }
  return maximal.reduce<Rec | undefined>((min, r) => (min === undefined || r.id < min.id ? r : min), undefined);
}

function group(recs: readonly Rec[], keysOf: (r: Rec) => readonly string[]): ReadonlyMap<string, readonly Rec[]> {
  const out = new Map<string, Rec[]>();
  for (const r of recs)
    for (const k of new Set(keysOf(r))) {
      const list = out.get(k);
      if (list === undefined) out.set(k, [r]);
      else list.push(r);
    }
  return out;
}

/** Each admitted key's governing admission (the first effective one after every effective revoke of it), in order. */
function governingAdmissions(dag: Dag, order: readonly Rec[], effective: readonly Rec[], revokes: Grouped) {
  const admissions = group(effective.filter(isAdmission), (r) => (r.subject === undefined ? [] : [r.subject]));
  const keys = new Set(order.filter(isAdmission).flatMap((r) => (r.subject === undefined ? [] : [r.subject])));
  const out: (readonly [string, Rec])[] = [];
  for (const k of keys) {
    const against = revokes.get(k) ?? [];
    const gov = admissions.get(k)?.find((a) => against.every((v) => dag.inPast(a.id, v.id)));
    if (gov !== undefined) out.push([k, gov]);
  }
  const position = dag.index.position;
  return out.toSorted((a, b) => (position.get(a[1].id) ?? 0) - (position.get(b[1].id) ?? 0));
}

type Grouped = ReadonlyMap<string, readonly Rec[]>;

export function membership(dag: Dag, S: RecordSet, statuses: ReadonlyMap<string, Status>): MemberView {
  const order = dag.index.relevant.filter((id) => S.has(id)).map((id) => dag.rec(id));
  const effective = order.filter((r) => statuses.get(r.id) === "eff");
  const revokes = group(
    effective.filter((r) => r.type === "revoke"),
    subjectsOf,
  );
  const ordered = governingAdmissions(dag, order, effective, revokes);
  const members = ordered.map(([k]) => k);
  const governed = new Set(members);
  const admitted = new Set(order.filter(isAdmission).flatMap((r) => (r.subject === undefined ? [] : [r.subject])));
  const revoked = [...admitted].filter((k) => !governed.has(k) && revokes.has(k)).toSorted();
  const updates = group(
    effective.filter((r) => r.type === "rekey" || r.type === "name"),
    (r) => (r.subject === undefined ? [] : [`${r.type}:${r.subject}`]),
  );
  const noise = new Map<string, string>();
  const rekeyed = new Map<string, string>();
  const admitter = new Map<string, string>();
  const governing = new Map<string, string>();
  const name = new Map<string, string>();
  const hostId = new Map<string, string>();
  const taken = new Set<string>();
  for (const [k, gov] of ordered) {
    admitter.set(k, gov.by);
    governing.set(k, gov.id);
    const after = (type: "rekey" | "name"): readonly Rec[] =>
      (updates.get(`${type}:${k}`) ?? []).filter((r) => dag.inPast(r.id, gov.id));
    const rekey = latest(dag, after("rekey"))?.card;
    if (rekey !== undefined) rekeyed.set(k, rekey.noise);
    const card = rekey ?? gov.card;
    if (card !== undefined) noise.set(k, card.noise);
    const host = gov.card?.hostId ?? "";
    hostId.set(k, host);
    const wanted = latest(dag, after("name"))?.name ?? gov.card?.name ?? "";
    const options = [wanted, ...fallbacks(wanted, host)];
    const chosen = options.find((option) => !taken.has(option)) ?? options[options.length - 1] ?? wanted;
    taken.add(chosen);
    name.set(k, chosen);
  }
  return { members, revoked, noise, rekeyed, admitter, governing, name, hostId };
}

export const withEff = (v: MemberView, eff: ReadonlySet<string>): EngineView => ({
  members: v.members,
  revoked: v.revoked,
  eff,
  noise: v.noise,
  rekeyed: v.rekeyed,
  admitter: v.admitter,
  governing: v.governing,
  name: v.name,
  hostId: v.hostId,
});
