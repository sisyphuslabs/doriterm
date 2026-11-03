// A large, mostly honest mesh for the M-14 benchmark and the differential fuzz: up to 12 members writing acks and
// names, members replaced over time, and every revoke written concurrently with one record of its subject (an ack or,
// every other time, a name), so each revoke is a real R3 conflict that every later view has to decide.

import { MAX_MESH_MEMBERS } from "../../src/records/types.ts";
import type { Rec } from "../../src/view/dag.ts";
import { pick, rng } from "../sim/world.ts";
import { ack, admit, type Draft, name, revoke } from "./records.ts";

export interface BigMeshOptions {
  readonly records: number;
  readonly revokes: number;
  readonly seed: number;
  /** The chance that two members write from the same heads (a fork that the next record merges). */
  readonly forks?: number;
}

export function bigMesh(o: BigMeshOptions): Rec[] {
  const r = rng(o.seed);
  const out: Rec[] = [];
  const counters = new Map<string, number>();
  let heads: string[] = [];
  let members: string[] = [];
  let fresh = 0;
  const write = (by: string, make: (id: string, prev: string[]) => Draft, prev = heads): Rec => {
    const n = (counters.get(by) ?? 0) + 1;
    counters.set(by, n);
    const rec: Rec = { ...make(`r${String(out.length).padStart(5, "0")}`, [...prev]), n };
    out.push(rec);
    return rec;
  };
  const advance = (...ids: string[]): void => {
    heads = ids;
  };
  const ackAll = (except: readonly string[]): void => {
    for (const k of members)
      if (!except.includes(k) && out.length < o.records) advance(write(k, (id, p) => ack(id, k, p)).id);
  };
  const admitOne = (): void => {
    const by = pick(r, members);
    const k = `K${fresh++}`;
    advance(write(by, (id, p) => admit(id, by, k, p)).id);
    members = [...members, k];
    ackAll([by]);
  };

  const founder = `K${fresh++}`;
  advance(write(founder, (id) => ({ ...admit(id, founder, founder, []), type: "found" })).id);
  members = [founder];
  while (members.length < MAX_MESH_MEMBERS && out.length < o.records) admitOne();
  let revoked = 0;
  while (out.length < o.records) {
    const due = revoked < o.revokes && out.length >= (o.records * (revoked + 1)) / (o.revokes + 2);
    if (due && members.length > 2) {
      const by = pick(r, members);
      const X = pick(
        r,
        members.filter((k) => k !== by),
      );
      const base = heads;
      const v = write(by, (id, p) => revoke(id, by, [X], p), base);
      const late =
        revoked % 2 === 0
          ? write(X, (id, p) => name(id, X, X, p, `${X}-late`), base)
          : write(X, (id, p) => ack(id, X, p), base);
      advance(v.id, late.id);
      members = members.filter((k) => k !== X);
      revoked++;
      ackAll([by]);
      if (out.length < o.records) admitOne();
      continue;
    }
    const by = pick(r, members);
    const roll = r.next();
    if (roll < (o.forks ?? 0.1) && members.length > 1) {
      const other = pick(
        r,
        members.filter((k) => k !== by),
      );
      const base = heads;
      const a = write(by, (id, p) => ack(id, by, p), base);
      if (out.length >= o.records) break;
      const b = write(other, (id, p) => name(id, other, other, p, `${other}-${out.length}`), base);
      advance(a.id, b.id);
    } else if (roll < 0.3) advance(write(by, (id, p) => name(id, by, by, p, `${by}-${out.length}`)).id);
    else advance(write(by, (id, p) => ack(id, by, p)).id);
  }
  return out;
}
