import { describe, expect, test } from "bun:test";
import { door } from "../src/door.ts";
import type { Signed } from "../src/records/types.ts";
import type { Rec } from "../src/view/dag.ts";
import { viewOf, viewOfRecords } from "../src/view/engine.ts";
import { recordsOf } from "../src/view/rec-of.ts";
import { ack, admit, found, withChainNumbers } from "./fixtures/records.ts";
import type { Scenario } from "./fixtures/scenario.ts";
import { cardScenarios } from "./fixtures/scenarios-cards.ts";
import { conflictScenarios } from "./fixtures/scenarios-conflict.ts";
import { reviewerScenarios } from "./fixtures/scenarios-reviewer.ts";
import { noiseOf, signScenario } from "./fixtures/signed.ts";
import { naiveView } from "./oracle/naive.ts";

const sorted = (keys: Iterable<string>): string[] => [...keys].toSorted();

interface Seen {
  readonly members: readonly string[];
  readonly overCap: readonly string[];
  readonly revoked: readonly string[];
  readonly noise: ReadonlyMap<string, string>;
  readonly admitter: ReadonlyMap<string, string>;
  readonly name: ReadonlyMap<string, string>;
}

function expectView(s: Scenario, view: Seen, noiseLabel: (label: string) => string): void {
  const want = s.residual ?? { members: s.expectMembers, revoked: s.expectRevoked };
  expect(sorted(view.members)).toEqual(sorted(want.members));
  expect(sorted(view.revoked)).toEqual(sorted(want.revoked));
  if (s.expectOverCap !== undefined) expect(sorted(view.overCap)).toEqual(sorted(s.expectOverCap));
  for (const [k, v] of Object.entries(s.expectNoise ?? {})) expect(view.noise.get(k)).toBe(noiseLabel(v));
  for (const [k, v] of Object.entries(s.expectAdmitter ?? {})) expect(view.admitter.get(k)).toBe(v);
  for (const [k, v] of Object.entries(s.expectName ?? {})) expect(view.name.get(k)).toBe(v);
}

function expectOracle(
  records: readonly Rec[],
  members: readonly string[],
  revoked: readonly string[],
  eff: Iterable<string>,
): void {
  const oracle = naiveView(records);
  expect([sorted(oracle.members), sorted(oracle.revoked), sorted(oracle.eff)]).toEqual([
    sorted(members),
    sorted(revoked),
    sorted(eff),
  ]);
}

/** A `batch` row as signed records: stored through the door, the batch refused, then the records written after. */
function throughTheDoor(s: Scenario): void {
  const all = withChainNumbers([...s.records, ...(s.batch ?? []), ...(s.after ?? [])]);
  const signed = signScenario(all);
  const of = (ids: readonly { readonly id: string }[]): Signed[] => ids.flatMap((d) => signed.byId.get(d.id) ?? []);
  const stored: Signed[] = [];
  const store = (r: Signed): void => {
    expect(door(r, stored)).toEqual({ ok: true });
    stored.push(r);
  };
  of(s.records).forEach(store);
  expect(of(s.batch ?? []).map((r) => door(r, stored))).toEqual(
    (s.refusals ?? []).map((reason) => ({ ok: false, held: false, reason })),
  );
  of(s.after ?? []).forEach(store);
  const named = (key: string): string => signed.nameOfKey.get(key) ?? key;
  const v = viewOf(stored);
  const byName = <T>(m: ReadonlyMap<string, T>): ReadonlyMap<string, T> =>
    new Map([...m].map(([k, x]) => [named(k), x]));
  const view: Seen = {
    members: [...v.members].map(named),
    overCap: [...v.overCap].map(named),
    revoked: [...v.revoked].map(named),
    noise: byName(v.noise),
    admitter: new Map([...v.admitter].map(([k, x]) => [named(k), named(x)])),
    name: byName(v.name),
  };
  expectView(s, view, noiseOf);
  expectOracle(recordsOf(stored) ?? [], [...v.members], [...v.revoked], v.eff);
}

const rows: readonly Scenario[] = [...reviewerScenarios, ...conflictScenarios, ...cardScenarios];

describe("M-5: the reviewer's R1-R5b, and the adversarial A1-A21 under R3", () => {
  for (const s of rows) {
    const residual =
      s.residual === undefined ? "" : ` [residual: fail closed, honest view {${sorted(s.expectMembers)}}]`;
    test(`${s.id}: ${s.title}${residual}`, () => {
      if (s.batch !== undefined) return throughTheDoor(s);
      const records = withChainNumbers([...s.records, ...(s.after ?? [])]);
      const view = viewOfRecords(records);
      expectView(s, view, (label) => label);
      expectOracle(records, view.members, view.revoked, view.eff);
    });
  }

  test("a fixture listed out of topological order is a fixture error, not a different DAG", () => {
    const drafts = withChainNumbers([found("F", "A"), admit("aB", "A", "B", ["F"]), ack("kB", "B", ["aB"])]);
    expect(() => signScenario(drafts.toReversed())).toThrow(RangeError);
  });
});
