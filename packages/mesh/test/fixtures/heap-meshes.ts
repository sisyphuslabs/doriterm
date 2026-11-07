// Meshes that stress what a ViewCache keeps, for the heap tests: each is a shape an attacker or an unlucky history
// can reach.

import { ack, admit, type Draft, found, name, revoke } from "./records.ts";

const keys = Array.from({ length: 12 }, (_, i) => `K${i}`);

/** Found K0 and admit the other members in one chain. */
function founded(): Draft[] {
  const drafts: Draft[] = [found("f", "K0")];
  for (const k of keys.slice(1)) drafts.push(admit(`a${k}`, "K0", k, [drafts.at(-1)?.id ?? "f"]));
  return drafts;
}

/** A full mesh whose every later record is a name: each record's past is a context of its own. */
export function namesOnly(records: number): Draft[] {
  const drafts = founded();
  while (drafts.length < records) {
    const k = keys[drafts.length % keys.length] ?? "K0";
    drafts.push(name(`n${drafts.length}`, k, k, [drafts.at(-1)?.id ?? "f"], `${k}-${drafts.length}`));
  }
  return drafts;
}

/** The founder admits key after key: every admitted key is a member. */
export function admitsOnly(records: number): Draft[] {
  const drafts = founded();
  while (drafts.length < records)
    drafts.push(admit(`z${drafts.length}`, "K0", `Z${drafts.length}`, [drafts.at(-1)?.id ?? "f"]));
  return drafts;
}

export interface Partition {
  readonly common: number;
  readonly branch: number;
  readonly revokes: number;
}

/**
 * A partition: `common` shared acks, then two branches of `branch` acks, one written by K0-K5 and one by K6-K11. The
 * second opens with `revokes` revokes of K0-K5 by K6, each concurrent with every record of the first branch, and 24
 * acks merge the branches. Every pair of a revoke and a record it accuses has the whole shared past in common.
 */
export function partition(o: Partition): Draft[] {
  const drafts = founded();
  const tip = (): string => drafts.at(-1)?.id ?? "f";
  for (let i = 0; i < o.common; i++) drafts.push(ack(`c${i}`, keys[i % keys.length] ?? "K0", [tip()]));
  const fork = tip();
  const [sideA, sideB] = [keys.slice(0, 6), keys.slice(6)];
  let a = fork;
  for (let i = 0; i < o.branch; i++) {
    drafts.push(ack(`a${i}`, sideA[i % sideA.length] ?? "K0", [a]));
    a = tip();
  }
  let b = fork;
  for (let i = 0; i < o.revokes; i++) {
    drafts.push(revoke(`v${i}`, "K6", sideA, [b]));
    b = tip();
  }
  for (let i = 0; i < o.branch; i++) {
    drafts.push(ack(`b${i}`, sideB[i % sideB.length] ?? "K6", [b]));
    b = tip();
  }
  drafts.push(ack("m0", "K6", [a, b]));
  for (let i = 1; i < 24; i++) drafts.push(ack(`m${i}`, keys[i % keys.length] ?? "K0", [tip()]));
  return drafts;
}
