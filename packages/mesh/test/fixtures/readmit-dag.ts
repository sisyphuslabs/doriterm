// Histories aimed at the context mechanism of the incremental engine (M-14): members revoke and re-admit each other
// (admitter cycles included), revokes race names of their subjects on concurrent branches, and some keys only ever
// ack, from one branch or across two, so a conflict between two non-ack records is often decided by ack testimony
// alone. An engine that drops a witness ack from a view's context gives a different view here.

import type { Rec } from "../../src/view/dag.ts";
import { pick, type Rng } from "../sim/world.ts";
import { ack, admit, type Draft, found, name, revoke, withChainNumbers } from "./records.ts";

const WRITERS = ["A", "B", "C", "D", "E"];
const ACKERS = ["W1", "W2", "W3"];
const MAX_TIPS = 4;

export function readmitDag(r: Rng, size: number): Rec[] {
  const drafts: Draft[] = [found("f", "A")];
  const admitted = new Set(["A"]);
  const revoked = new Set<string>();
  let tips = ["f"];
  const add = (make: (id: string, prev: readonly string[]) => Draft, prev: readonly string[]): string => {
    const d = make(`x${String(drafts.length).padStart(3, "0")}`, prev);
    drafts.push(d);
    tips = [...tips.filter((t) => !prev.includes(t)), d.id];
    return d.id;
  };
  const onBranch = (): string[] => [pick(r, tips)];
  // An acker testifies on one side of the conflict (v, y), a member merges both sides without it, and a third record
  // merges the testimony in: past(x1) and past(x2) differ only by that ack, which alone breaks the 0:0.
  const witnessed = (v: string, y: string): void => {
    const w = add((id, prev) => ack(id, pick(r, ACKERS), prev), [r.next() < 0.5 ? v : y]);
    const x1 = add((id, prev) => ack(id, pick(r, WRITERS), prev), [v, y]);
    add((id, prev) => ack(id, pick(r, [...WRITERS, ...ACKERS]), prev), [x1, w]);
  };
  const across = (): string[] => (tips.length > 1 ? [...new Set([pick(r, tips), pick(r, tips)])] : [...tips]);
  for (const k of [...WRITERS.slice(1), ...ACKERS]) {
    add((id, prev) => admit(id, pick(r, [...admitted]), k, prev), [...tips]);
    admitted.add(k);
  }
  while (drafts.length < size) {
    const roll = r.next();
    const members = [...admitted].filter((k) => !revoked.has(k));
    const by = pick(r, members.length > 0 ? members : ["A"]);
    if (roll < 0.15 && members.length > 2) {
      const subject = pick(
        r,
        members.filter((k) => k !== by),
      );
      const base = onBranch();
      const v = add((id, prev) => revoke(id, by, [subject], prev), base);
      const y = add((id, prev) => name(id, subject, subject, prev, `${id}-name`), base);
      revoked.add(subject);
      if (r.next() < 0.7) witnessed(v, y);
    } else if (roll < 0.3 && revoked.size > 0) {
      const subject = pick(r, [...revoked]);
      add((id, prev) => admit(id, by, subject, prev, `${id}-key`), r.next() < 0.5 ? onBranch() : across());
      revoked.delete(subject);
    } else if (roll < 0.4) add((id, prev) => name(id, by, by, prev, `${id}-name`), onBranch());
    else if (roll < 0.85) add((id, prev) => ack(id, pick(r, ACKERS), prev), r.next() < 0.7 ? onBranch() : across());
    else add((id, prev) => ack(id, by, prev), tips.length > MAX_TIPS || r.next() < 0.5 ? [...tips] : across());
  }
  return withChainNumbers(drafts);
}
