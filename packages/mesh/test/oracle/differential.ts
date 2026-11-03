// The comparison behind the differential fuzz (M-14): the incremental engine in src/view against the previous engine
// kept verbatim in legacy/, every field of every view in its own iteration order.

import { Dag, type Rec } from "../../src/view/dag.ts";
import { Engine, type ViewCache, viewOfRecords } from "../../src/view/engine.ts";
import { Dag as LegacyDag } from "./legacy/dag.ts";
import { Engine as LegacyEngine, viewOfRecords as legacyViewOfRecords } from "./legacy/engine.ts";

export interface Shaped {
  readonly members: Iterable<string>;
  readonly overCap: Iterable<string>;
  readonly revoked: Iterable<string>;
  readonly eff: Iterable<string>;
  readonly noise: Iterable<readonly [string, string]>;
  readonly admitter: Iterable<readonly [string, string]>;
  readonly name: Iterable<readonly [string, string]>;
  readonly governing?: Iterable<readonly [string, string]>;
  readonly hostId?: Iterable<readonly [string, string]>;
}

/** Every field of a view, in its own iteration order: byte-identical means this string is identical. */
export const shape = (v: Shaped): string =>
  JSON.stringify([
    [...v.members],
    [...v.overCap],
    [...v.revoked],
    [...v.eff],
    [...v.noise],
    [...v.admitter],
    [...(v.governing ?? [])],
    [...v.name],
    [...(v.hostId ?? [])],
  ]);

export const same = (records: readonly Rec[], cache?: ViewCache): boolean =>
  shape(viewOfRecords(records, cache)) === shape(legacyViewOfRecords(records));

/** The full view and view(past(x)) for every record x, so the per-record views and their lazy eff are compared too. */
export function sameEverywhere(records: readonly Rec[]): boolean {
  const e = new Engine(new Dag(records));
  const l = new LegacyEngine(new LegacyDag(records));
  if (shape(e.full()) !== shape(l.full())) return false;
  return records.every((r) => {
    const a = e.pastView(r.id);
    const b = l.before(r.id);
    return a === undefined || b === undefined ? a === b : shape(a) === shape(b);
  });
}

/** past(x) ∪ {x} over every root: a past-closed sub-set, in the records' own order. */
export function pastClosed(records: readonly Rec[], roots: readonly string[]): Rec[] {
  const dag = new Dag(records);
  const keep = new Set(roots.flatMap((id) => [id, ...dag.past(id)]));
  return records.filter((r) => keep.has(r.id));
}

export const SEEDS = [1, 2, 3, 4, 5, 7, 11, 13] as const;
