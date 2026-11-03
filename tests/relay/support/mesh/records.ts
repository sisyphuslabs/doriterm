import { base64urlEncode, type HostIdentity } from "@doriface/crypto";
import { type BackdateShape, FORK, type Step } from "./backdate-graphs.ts";
import type { MeshLib } from "./mesh-lib.ts";
import type { SignedRecord } from "./status.ts";

/** A key pair in the mesh, with the card fields a record about it needs. */
export interface Actor {
  readonly keys: HostIdentity;
  readonly name: string;
  readonly hcId: string;
  readonly signPub: string;
}

export const actorOf = (keys: HostIdentity, name: string, hcId: string): Actor => ({
  keys,
  name,
  hcId,
  signPub: base64urlEncode(keys.sign.publicKey),
});

/** A record's place in its signer's chain: what the next record by that signer continues from. */
export interface Head {
  readonly n: number;
  readonly hash: string;
}

const nonce = (): string => base64urlEncode(crypto.getRandomValues(new Uint8Array(16)));

/** The subject's own card (H1), asking to join `mesh` through `inviter`. */
export function cardOf(lib: MeshLib, mesh: string, inviter: string, subject: Actor): SignedRecord {
  const card = {
    v: 1,
    mesh,
    inviter,
    nonce: nonce(),
    hostId: subject.keys.hostId,
    signPub: subject.signPub,
    noisePub: base64urlEncode(subject.keys.noise.publicKey),
    name: subject.name,
    hcId: subject.hcId,
  };
  return lib.signCard(card, subject.keys.sign.secretKey);
}

export interface Signing {
  readonly lib: MeshLib;
  readonly mesh: string;
  readonly by: Actor;
  readonly n: number;
  readonly prev: readonly string[];
}

const bodyOf = (s: Signing, type: string, subject?: object): object => ({
  v: 2,
  mesh: s.mesh,
  type,
  by: s.by.signPub,
  n: s.n,
  prev: s.prev,
  ...(subject === undefined ? {} : { subject }),
});

export const signAdmit = (s: Signing, card: SignedRecord): SignedRecord =>
  s.lib.signRecord(bodyOf(s, "admit", { card }), s.by.keys.sign.secretKey);

export const signRevoke = (s: Signing, subjects: readonly Actor[]): SignedRecord =>
  s.lib.signRecord(
    bodyOf(s, "revoke", { signPubs: subjects.map((subject) => subject.signPub), reason: "revoke" }),
    s.by.keys.sign.secretKey,
  );

export const signAck = (s: Signing): SignedRecord => s.lib.signRecord(bodyOf(s, "ack"), s.by.keys.sign.secretKey);

/** The card an admit or found record embeds. */
export function cardIn(record: SignedRecord): SignedRecord | undefined {
  const body: unknown = JSON.parse(record.body);
  const subject = typeof body === "object" && body !== null && "subject" in body ? body.subject : undefined;
  const card = typeof subject === "object" && subject !== null && "card" in subject ? subject.card : undefined;
  return typeof card === "object" &&
    card !== null &&
    "body" in card &&
    "sig" in card &&
    typeof card.body === "string" &&
    typeof card.sig === "string"
    ? { body: card.body, sig: card.sig }
    : undefined;
}

/** A `found` of a mesh of one, signed by `founder`: a second, foreign mesh's root. */
export function foundRecord(lib: MeshLib, founder: Actor): SignedRecord {
  const s = { lib, mesh: "-", by: founder, n: 1, prev: [] };
  return lib.signRecord(bodyOf(s, "found", { card: cardOf(lib, "-", "-", founder) }), founder.keys.sign.secretKey);
}

/** The newest record `signPub` wrote in `records`: where a chain of its own continues. */
export function lastOwn(lib: MeshLib, records: readonly SignedRecord[], signPub: string): Head {
  let best: Head | undefined;
  for (const record of records) {
    const body: unknown = JSON.parse(record.body);
    if (typeof body !== "object" || body === null || !("by" in body) || !("n" in body)) continue;
    if (body.by === signPub && typeof body.n === "number" && (best === undefined || body.n > best.n)) {
      best = { n: body.n, hash: lib.hashOf(record) };
    }
  }
  if (best === undefined) throw new Error(`no record by ${signPub}`);
  return best;
}

export interface SignedGraph {
  /** In the graph's causal order. */
  readonly records: readonly SignedRecord[];
  readonly hashes: ReadonlyMap<string, string>;
}

/**
 * Signs a shape's attack edge for edge. `prev` is the graph's own, with `FORK` as the revoked key's last own record,
 * and each counter is the one an honest signer would have used: 1 + the highest of its own records in the past, so
 * concurrent records by one signer share a counter, as they do in the model.
 */
export function signAttack(
  lib: MeshLib,
  mesh: string,
  shape: BackdateShape,
  actors: ReadonlyMap<string, Actor>,
  fork: Head,
): SignedGraph {
  const hashes = new Map<string, string>([[FORK, fork.hash]]);
  const steps = new Map<string, Step>();
  const actor = (key: string): Actor => {
    const found = actors.get(key);
    if (found === undefined) throw new Error(`${shape.id}: no keys for ${key}`);
    return found;
  };
  const counterIn = (ids: readonly string[], by: string, seen = new Set<string>()): number =>
    Math.max(
      0,
      ...ids.map((id) => {
        if (seen.has(id)) return 0;
        seen.add(id);
        if (id === FORK) return by === shape.revoked ? fork.n : 0;
        const step = steps.get(id);
        if (step === undefined) throw new Error(`${shape.id}: ${id} is not before its successor`);
        return Math.max(step.by === by ? counterOf(step) : 0, counterIn(step.prev, by, seen));
      }),
    );
  const counters = new Map<string, number>();
  const counterOf = (step: Step): number => counters.get(step.id) ?? 0;
  const records: SignedRecord[] = [];
  for (const step of shape.attack) {
    const n = 1 + counterIn(step.prev, step.by);
    counters.set(step.id, n);
    steps.set(step.id, step);
    const prev = step.prev.map((id) => hashes.get(id) ?? "");
    const s: Signing = { lib, mesh, by: actor(step.by), n, prev };
    const record = signStep(s, step, actor, mesh);
    hashes.set(step.id, lib.hashOf(record));
    records.push(record);
  }
  hashes.delete(FORK);
  return { records, hashes };
}

function signStep(s: Signing, step: Step, actor: (key: string) => Actor, mesh: string): SignedRecord {
  switch (step.type) {
    case "admit":
      return signAdmit(s, cardOf(s.lib, mesh, s.by.signPub, actor(step.subject ?? "")));
    case "revoke":
      return signRevoke(s, (step.subjects ?? []).map(actor));
    case "ack":
      return signAck(s);
    case "found":
    case "name":
      throw new Error(`no attack step writes a ${step.type}`);
  }
}
