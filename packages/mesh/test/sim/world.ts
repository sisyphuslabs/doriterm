// Seeded random histories for the property tests: honest hosts that write concurrently from partial knowledge,
// gossip, and ack every membership record they merge, plus attackers that sign anything with any prev.

import { Dag, type Rec } from "../../src/view/dag.ts";
import { Engine, type ViewCache } from "../../src/view/engine.ts";
import type { EngineView } from "../../src/view/membership.ts";
import { ack, admit, type Draft, name, rekey, revoke } from "../fixtures/records.ts";

export interface Rng {
  next(): number;
}

/** mulberry32, so a failing seed can be re-run. */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

export function pick<T>(r: Rng, items: readonly T[]): T {
  const item = items[Math.floor(r.next() * items.length)];
  if (item === undefined) throw new RangeError("pick from an empty list");
  return item;
}

const isMembershipRecord = (r: Rec): boolean => r.type === "admit" || r.type === "revoke" || r.type === "rekey";
export const headsOf = (records: readonly Rec[]): string[] => {
  const named = new Set(records.flatMap((r) => r.prev));
  return records.filter((r) => !named.has(r.id)).map((r) => r.id);
};

export class World {
  readonly records: Rec[] = [];
  readonly know = new Map<string, Set<string>>();
  readonly memo: ViewCache = new Map();
  readonly acks: boolean;
  #n = 0;

  constructor(acks = true) {
    this.acks = acks;
  }

  id(prefix: string): string {
    return `${prefix}${++this.#n}`;
  }

  subset(ids: ReadonlySet<string>): Rec[] {
    return this.records.filter((r) => ids.has(r.id));
  }

  viewOf(ids: ReadonlySet<string>): EngineView {
    return new Engine(new Dag(this.subset(ids)), this.memo).full();
  }

  full(): EngineView {
    return this.viewOf(new Set(this.records.map((r) => r.id)));
  }

  /** The highest counter `by` has used anywhere (an attacker always knows its own records). */
  lastOf(by: string): Rec | undefined {
    return this.records.filter((r) => r.by === by).toSorted((a, b) => b.n - a.n)[0];
  }

  /** Appends a record written by `by` with its whole knowledge as prev; the writer then knows it. */
  write(by: string, make: (id: string, prev: string[]) => Draft, prefix: string): Rec {
    const mine = this.know.get(by) ?? new Set<string>();
    const n =
      1 +
      Math.max(
        0,
        ...this.subset(mine)
          .filter((r) => r.by === by)
          .map((r) => r.n),
      );
    const r: Rec = { ...make(this.id(prefix), headsOf(this.subset(mine))), n };
    this.records.push(r);
    mine.add(r.id);
    this.know.set(by, mine);
    return r;
  }

  /** `to` merges everything `from` knows; it acks if that brought it membership records written by others. */
  gossip(from: string, to: string): void {
    const a = this.know.get(from);
    const b = this.know.get(to);
    if (a === undefined || b === undefined) return;
    const fresh = [...a].filter((id) => !b.has(id));
    for (const id of fresh) b.add(id);
    const news = this.records.filter((r) => fresh.includes(r.id));
    if (!this.acks || !news.some((r) => isMembershipRecord(r) && r.by !== to)) return;
    if (this.viewOf(b).members.includes(to)) this.write(to, (id, prev) => ack(id, to, prev), "k");
  }
}

const HONEST = ["A", "B", "C", "D", "E", "G", "H", "J"];

/** An honest history: concurrent writers, partial knowledge, admits, revokes (some mutual), names, rekeys. */
export function honestHistory(r: Rng, steps: number, world = new World(), joinerAcks = false): World {
  world.records.push({ ...admit("F", "A", "A", []), type: "found", n: 1 });
  world.know.set("A", new Set(["F"]));
  for (let i = 0; i < steps; i++) {
    const hosts = [...world.know.keys()];
    if (r.next() < 0.4 && hosts.length > 1) {
      world.gossip(pick(r, hosts), pick(r, hosts));
      continue;
    }
    const by = pick(r, hosts);
    const view = world.viewOf(world.know.get(by) ?? new Set());
    if (!view.members.includes(by)) continue;
    const roll = r.next();
    const admitted = new Set(world.records.flatMap((x) => (x.card === undefined ? [] : [x.card.by])));
    const fresh = HONEST.filter((k) => !admitted.has(k));
    if (roll < 0.4 && fresh.length > 0) {
      const k = pick(r, fresh);
      const a = world.write(by, (id, prev) => admit(id, by, k, prev), "a");
      world.know.set(k, new Set([...(world.know.get(by) ?? []), a.id]));
      if (joinerAcks) world.write(k, (id, prev) => ack(id, k, prev), "k");
    } else if (roll < 0.55 && view.members.length > 2) {
      const target = pick(
        r,
        view.members.filter((k) => k !== by),
      );
      world.write(by, (id, prev) => revoke(id, by, [target], prev), "v");
    } else if (roll < 0.75) world.write(by, (id, prev) => name(id, by, pick(r, view.members), prev, `n${i}`), "n");
    else if (roll < 0.8) world.write(by, (id, prev) => rekey(id, by, prev, `${by}-key-${i}`), "r");
    else world.write(by, (id, prev) => ack(id, by, prev), "k");
  }
  return world;
}

/** Everyone the view says `root` admitted, transitively (the `revoke --compromised` batch). */
export function subtreeOf(view: EngineView, root: string): string[] {
  const out = new Set([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [k, by] of view.admitter) {
      if (out.has(by) && !out.has(k) && view.members.includes(k)) {
        out.add(k);
        grew = true;
      }
    }
  }
  return [...out];
}

/**
 * Attacker records signed by batch keys (and keys they mint), each chained from its signer's last record plus a prev
 * drawn from `pool`; one in ten equivocates by chaining from an older record of its signer.
 */
export function attack(
  r: Rng,
  world: World,
  batch: readonly string[],
  honest: readonly string[],
  pool: readonly string[],
  count: number,
): Rec[] {
  const signers = [...batch];
  const mine: string[] = [];
  const out: Rec[] = [];
  for (let j = 0; j < count; j++) {
    const by = pick(r, signers);
    const own = world.records.filter((x) => x.by === by);
    const parent = own.length > 1 && r.next() < 0.1 ? pick(r, own) : world.lastOf(by);
    const prev = [...new Set([...(parent === undefined ? [] : [parent.id]), pick(r, [...pool, ...mine])])];
    const n = (parent?.n ?? 0) + 1;
    const roll = r.next();
    const id = world.id("x");
    let draft: Draft;
    if (roll < 0.3) {
      const fellow = batch.filter((k) => k !== by);
      const z = r.next() < 0.3 && fellow.length > 0 ? pick(r, fellow) : `Z${j}`;
      draft = admit(id, by, z, prev);
      if (!signers.includes(z)) signers.push(z);
    } else if (roll < 0.6) {
      const targets = honest.filter(() => r.next() < 0.6);
      draft = revoke(id, by, targets.length > 0 ? targets : [pick(r, honest)], prev);
    } else if (roll < 0.75) draft = name(id, by, pick(r, honest), prev, `pwn${j}`);
    else if (roll < 0.85) draft = rekey(id, by, prev, `${by}-evil-${j}`);
    else draft = ack(id, by, prev);
    const rec: Rec = { ...draft, n };
    world.records.push(rec);
    out.push(rec);
    mine.push(rec.id);
  }
  return out;
}
