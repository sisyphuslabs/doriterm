// membership(S, eff) of contract v1.5 "Membership": from the effective records of S to the view (members, cap,
// revoked keys, Noise keys, admitter lineage, names).

import { MAX_MESH_MEMBERS } from "../records/types.ts";
import { fallbacks } from "../names.ts";
import { type Dag, isAdmission, type Rec, revokesKey } from "./dag.ts";

export interface EngineView {
  /** The first 12 keys with a governing admission, in the canonical order of those admissions. */
  readonly members: readonly string[];
  /** Keys past the cap, in the same order: not dialed, cannot sign. */
  readonly overCap: readonly string[];
  readonly revoked: readonly string[];
  readonly eff: ReadonlySet<string>;
  readonly noise: ReadonlyMap<string, string>;
  readonly admitter: ReadonlyMap<string, string>;
  readonly governing: ReadonlyMap<string, string>;
  readonly name: ReadonlyMap<string, string>;
  readonly hostId: ReadonlyMap<string, string>;
}

/** The maximal records of a list (none of the others has it in its past); ties by smallest id. */
function latest(dag: Dag, recs: readonly Rec[]): Rec | undefined {
  const maximal = recs.filter((r) => !recs.some((o) => o !== r && dag.past(o.id).has(r.id)));
  return [...maximal].toSorted((a, b) => (a.id < b.id ? -1 : 1))[0];
}

function governingAdmissions(
  dag: Dag,
  S: ReadonlySet<string>,
  eff: ReadonlySet<string>,
): readonly (readonly [string, Rec])[] {
  const order = dag.canonicalOrder(S).map((id) => dag.rec(id));
  const effective = order.filter((r) => eff.has(r.id));
  const keys = [...new Set(order.filter(isAdmission).flatMap((r) => (r.subject === undefined ? [] : [r.subject])))];
  const out: (readonly [string, Rec])[] = [];
  for (const k of keys) {
    const revokes = effective.filter((v) => revokesKey(v, k));
    const gov = effective.find(
      (a) => isAdmission(a) && a.subject === k && revokes.every((v) => dag.past(a.id).has(v.id)),
    );
    if (gov !== undefined) out.push([k, gov]);
  }
  const position = new Map(order.map((r, i) => [r.id, i]));
  return out.toSorted((a, b) => (position.get(a[1].id) ?? 0) - (position.get(b[1].id) ?? 0));
}

export function membership(dag: Dag, S: ReadonlySet<string>, eff: ReadonlySet<string>): EngineView {
  const ordered = governingAdmissions(dag, S, eff);
  const effective = [...S].map((id) => dag.rec(id)).filter((r) => eff.has(r.id));
  const admitted = new Set(
    [...S]
      .map((id) => dag.rec(id))
      .filter(isAdmission)
      .map((r) => r.subject),
  );
  const members = ordered.slice(0, MAX_MESH_MEMBERS).map(([k]) => k);
  const overCap = ordered.slice(MAX_MESH_MEMBERS).map(([k]) => k);
  const governed = new Set(ordered.map(([k]) => k));
  const revoked = [...admitted]
    .flatMap((k) => (k === undefined || governed.has(k) ? [] : [k]))
    .filter((k) => effective.some((v) => revokesKey(v, k)))
    .toSorted();
  const noise = new Map<string, string>();
  const admitter = new Map<string, string>();
  const governing = new Map<string, string>();
  const name = new Map<string, string>();
  const hostId = new Map<string, string>();
  const taken = new Set<string>();
  for (const [k, gov] of ordered.slice(0, MAX_MESH_MEMBERS)) {
    admitter.set(k, gov.by);
    governing.set(k, gov.id);
    const after = (type: Rec["type"]): readonly Rec[] =>
      effective.filter((r) => r.type === type && r.subject === k && dag.past(r.id).has(gov.id));
    const card = latest(dag, after("rekey"))?.card ?? gov.card;
    if (card !== undefined) noise.set(k, card.noise);
    const host = gov.card?.hostId ?? "";
    hostId.set(k, host);
    const wanted = latest(dag, after("name"))?.name ?? gov.card?.name ?? "";
    const options = [wanted, ...fallbacks(wanted, host)];
    const chosen = options.find((option) => !taken.has(option)) ?? options[options.length - 1] ?? wanted;
    taken.add(chosen);
    name.set(k, chosen);
  }
  return { members, overCap, revoked, eff, noise, admitter, governing, name, hostId };
}
