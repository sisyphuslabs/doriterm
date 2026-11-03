// The seeded property runs of design section 11 PR 2: M-3a (agreement with the oracle), M-11 (no takeover after an
// acked revoke) and M-12 (no colluder wins). M-11 and M-12 count failures (takeovers and decidable removals); the
// disclosed categories are counted and reported, never pinned.

import { naiveView } from "../oracle/naive.ts";
import { ack, revoke } from "../fixtures/records.ts";
import { classifyChange, colluderMajority } from "./classify.ts";
import { attack, honestHistory, pick, type Rng, subtreeOf, World } from "./world.ts";

export interface Outcome {
  readonly tried: number;
  /** Takeovers plus decidable removals (M-11), or colluder wins outside residual 2 (M-12). */
  readonly bad: number;
  readonly report: string;
}

export interface StickinessOptions {
  readonly compromised: boolean;
  /** The smallest mesh a history may have at the revoke; 2 includes the N = 2 family. */
  readonly minMembers: number;
  readonly joinerAcks: boolean;
}

const learnAll = (w: World, host: string): void => void w.know.set(host, new Set(w.records.map((r) => r.id)));

/** Revokes with full knowledge, then every other honest member acks (sequentially or all from the same base). */
function revokeAndAck(r: Rng, w: World, subjects: readonly string[], honest: readonly string[]): string[] {
  const pre = w.records.map((x) => x.id);
  const revoker = pick(r, honest);
  learnAll(w, revoker);
  w.write(revoker, (id, prev) => revoke(id, revoker, subjects, prev), "v");
  const sequential = r.next() < 0.5;
  const base = new Set(w.records.map((x) => x.id));
  for (const h of honest.filter((k) => k !== revoker)) {
    w.know.set(h, sequential ? new Set(w.records.map((x) => x.id)) : new Set(base));
    if (w.acks) w.write(h, (id, prev) => ack(id, h, prev), "k");
  }
  return pre;
}

/** M-3a: the engine and the independent evaluator agree on seeded adversarial DAGs. */
export function agreement(r: Rng, runs: number): Outcome {
  let bad = 0;
  for (let i = 0; i < runs; i++) {
    const w = honestHistory(r, 10);
    const members = w.full().members.filter((k) => k !== "A");
    if (members.length > 0)
      attack(
        r,
        w,
        [pick(r, members)],
        ["A"],
        w.records.map((x) => x.id),
        4,
      );
    const ref = w.full();
    const nv = naiveView(w.records);
    const shape = (v: typeof nv | typeof ref): string =>
      JSON.stringify([
        v.members,
        v.revoked,
        [...v.noise].toSorted(),
        [...v.admitter].toSorted(),
        [...v.eff].toSorted(),
      ]);
    if (shape(ref) !== shape(nv)) bad++;
  }
  return { tried: runs, bad, report: `${runs} DAGs, ${bad} disagreements` };
}

/** M-11: once every honest member acked revoke(batch), nothing the batch signs takes over or removes at a decidable fork. */
export function stickiness(r: Rng, runs: number, o: StickinessOptions): Outcome {
  const counts = { takeover: 0, decidable: 0, failClosed: 0, revived: 0, residual2: 0, residual3: 0 };
  let tried = 0;
  for (let i = 0; i < runs; i++) {
    const w = honestHistory(r, 14, new World(), o.joinerAcks);
    const before = w.full();
    if (before.members.length < o.minMembers) continue;
    const X = pick(r, before.members);
    const batch = o.compromised ? subtreeOf(before, X) : [X];
    const honest = before.members.filter((k) => !batch.includes(k));
    if (honest.length < batch.length || (honest.length === batch.length && o.minMembers > 2)) continue;
    tried++;
    const pre = revokeAndAck(r, w, batch, honest);
    const acked = [...w.records];
    const baseView = w.full();
    const made = attack(r, w, batch, honest, pre, 7);
    const kind = classifyChange(w, acked, batch, baseView, made);
    if (kind === "takeover") counts.takeover++;
    else if (kind === "removal-decidable") counts.decidable++;
    else if (kind === "removal-undecidable") counts.failClosed++;
    else if (kind === "revived-undecidable") counts.revived++;
    else if (kind === "colluder-majority") counts.residual2++;
    else if (kind === "sole-witness") counts.residual3++;
  }
  const report =
    `${tried} histories: ${counts.takeover} takeovers, ${counts.decidable} decidable removals; reported: ` +
    `${counts.failClosed} fail closed, ${counts.revived} revived, ${counts.residual2} residual 2, ${counts.residual3} residual 3`;
  return { tried, bad: counts.takeover + counts.decidable, report };
}

/** M-12: two colluders revoked separately, every honest member acked, |H| > 2: no colluder or its admittee survives. */
export function noAttackerWin(r: Rng, runs: number): Outcome {
  let bad = 0;
  let atFork = 0;
  let tried = 0;
  for (let i = 0; i < runs; i++) {
    const w = honestHistory(r, 14);
    const before = w.full();
    if (before.members.length < 4) continue;
    const X1 = pick(r, before.members);
    const X2 = pick(
      r,
      before.members.filter((k) => k !== X1),
    );
    const honest = before.members.filter((k) => k !== X1 && k !== X2);
    if (honest.length <= 2) continue;
    tried++;
    const pre = w.records.map((x) => x.id);
    revokeAndAck(r, w, [X1], honest);
    revokeAndAck(r, w, [X2], honest);
    const acked = [...w.records];
    const made = attack(r, w, [X1, X2], honest, pre, 8);
    const minted = (k: string): boolean => made.some((m) => m.subject === k && m.type === "admit");
    if (!w.full().members.some((k) => k === X1 || k === X2 || minted(k))) continue;
    if (colluderMajority(w, acked, [X1, X2], made)) atFork++;
    else bad++;
  }
  return { tried, bad, report: `${tried} histories: ${bad} colluder wins; reported: ${atFork} residual 2 at the fork` };
}
