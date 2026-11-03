// membership(S, eff) of contract v1.5 "Membership": from the effective records of S to the view (members, cap,
// revoked keys, Noise keys, admitter lineage, names). It reads every record type but ack, so the engine decides only
// those statuses before calling it.

import { MAX_MESH_MEMBERS } from "../records/types.ts";
import { fallbacks } from "../names.ts";
import { type Dag, isAdmission, type Rec, type RecordSet, subjectsOf } from "./dag.ts";
import type { Status } from "./status.ts";

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

export function membership(
  dag: Dag,
  S: RecordSet,
  statuses: ReadonlyMap<string, Status>,
  effOf: () => ReadonlySet<string>,
): EngineView {
  const order = dag.index.relevant.filter((id) => S.has(id)).map((id) => dag.rec(id));
  const effective = order.filter((r) => statuses.get(r.id) === "eff");
  const revokes = group(
    effective.filter((r) => r.type === "revoke"),
    subjectsOf,
  );
  const ordered = governingAdmissions(dag, order, effective, revokes);
  const members = ordered.slice(0, MAX_MESH_MEMBERS).map(([k]) => k);
  const overCap = ordered.slice(MAX_MESH_MEMBERS).map(([k]) => k);
  const governed = new Set(ordered.map(([k]) => k));
  const admitted = new Set(order.filter(isAdmission).flatMap((r) => (r.subject === undefined ? [] : [r.subject])));
  const revoked = [...admitted].filter((k) => !governed.has(k) && revokes.has(k)).toSorted();
  const updates = group(
    effective.filter((r) => r.type === "rekey" || r.type === "name"),
    (r) => (r.subject === undefined ? [] : [`${r.type}:${r.subject}`]),
  );
  const noise = new Map<string, string>();
  const admitter = new Map<string, string>();
  const governing = new Map<string, string>();
  const name = new Map<string, string>();
  const hostId = new Map<string, string>();
  const taken = new Set<string>();
  // admitter and governing hold every key with a governing admission, over-cap keys too (contract membership()).
  for (const [k, gov] of ordered) {
    admitter.set(k, gov.by);
    governing.set(k, gov.id);
  }
  for (const [k, gov] of ordered.slice(0, MAX_MESH_MEMBERS)) {
    const after = (type: "rekey" | "name"): readonly Rec[] =>
      (updates.get(`${type}:${k}`) ?? []).filter((r) => dag.inPast(r.id, gov.id));
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
  return withEff({ members, overCap, revoked, noise, admitter, governing, name, hostId }, effOf);
}

/** A view with these members, keys and names whose `eff` is computed on first read. */
export function withEff(v: Omit<EngineView, "eff">, effOf: () => ReadonlySet<string>): EngineView {
  let eff: ReadonlySet<string> | undefined;
  return {
    members: v.members,
    overCap: v.overCap,
    revoked: v.revoked,
    get eff() {
      eff ??= effOf();
      return eff;
    },
    noise: v.noise,
    admitter: v.admitter,
    governing: v.governing,
    name: v.name,
    hostId: v.hostId,
  };
}
