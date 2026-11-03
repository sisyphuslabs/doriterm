// Abstract record constructors with the shapes of contract v1.5 "Records", for the view tests. `id` stands for the
// record hash and a key name for a signPub; `withChainNumbers` gives every record the counter an honest signer uses.

import { type Card, Dag, type Rec } from "../../src/view/dag.ts";

export type Draft = Omit<Rec, "n"> & { readonly n?: number };

let nonces = 0;
export const card = (subject: string, inviter: string, noise = `${subject}-key`, nonce = `n${++nonces}`): Card => ({
  by: subject,
  hostId: `h${subject.toLowerCase()}`,
  inviter,
  noise,
  name: subject.toLowerCase(),
  nonce,
});

export const found = (id: string, by: string): Draft => ({
  id,
  type: "found",
  by,
  subject: by,
  prev: [],
  card: card(by, "-"),
});

export const admit = (id: string, by: string, subject: string, prev: readonly string[], noise?: string): Draft => ({
  id,
  type: "admit",
  by,
  subject,
  prev,
  card: card(subject, by, noise),
});

/** An admit that reuses an existing card (a replay of the subject's old card). */
export const admitWithCard = (id: string, by: string, c: Card, prev: readonly string[]): Draft => ({
  id,
  type: "admit",
  by,
  subject: c.by,
  prev,
  card: c,
});

/** An admit whose card the admitter signed instead of its subject: the door refuses it. */
export const forgedAdmit = (
  id: string,
  by: string,
  subject: string,
  prev: readonly string[],
  noise: string,
): Draft => ({
  id,
  type: "admit",
  by,
  subject,
  prev,
  card: { ...card(subject, by, noise), by },
});

/** A rekey of `subject` signed by someone else: the door refuses it. */
export const foreignRekey = (
  id: string,
  by: string,
  subject: string,
  prev: readonly string[],
  noise: string,
): Draft => ({
  id,
  type: "rekey",
  by,
  subject,
  prev,
  card: card(subject, by, noise),
});

export const revoke = (id: string, by: string, subjects: readonly string[], prev: readonly string[]): Draft => ({
  id,
  type: "revoke",
  by,
  subjects,
  prev,
});

export const name = (id: string, by: string, subject: string, prev: readonly string[], to = `${subject}-2`): Draft => ({
  id,
  type: "name",
  by,
  subject,
  prev,
  name: to.toLowerCase(),
});

export const ack = (id: string, by: string, prev: readonly string[]): Draft => ({ id, type: "ack", by, prev });

export const rekey = (id: string, by: string, prev: readonly string[], noise: string): Draft => ({
  id,
  type: "rekey",
  by,
  subject: by,
  prev,
  card: card(by, by, noise),
});

/**
 * Gives every draft without `n` the number an honest signer would use: 1 + the highest `n` among the signer's records
 * in its past. Concurrent drafts by one signer thus share a number (an equivocation), as an attacker's would.
 */
export function withChainNumbers(drafts: readonly Draft[]): Rec[] {
  const dag = new Dag(drafts.map((d) => ({ ...d, n: d.n ?? 0 })));
  const out = new Map<string, Rec>();
  for (const id of dag.index.order) {
    const d = drafts.find((x) => x.id === id);
    if (d === undefined) continue;
    const mine = [...dag.past(id)].flatMap((p) => {
      const q = out.get(p);
      return q !== undefined && q.by === d.by ? [q.n] : [];
    });
    out.set(id, { ...d, n: d.n ?? 1 + Math.max(0, ...mine) });
  }
  return drafts.flatMap((d) => out.get(d.id) ?? []);
}
