import { base64urlEncode, type HostIdentity } from "@doriface/crypto";
import type { SignedRecord } from "./status.ts";

/**
 * What the scenarios need from `packages/mesh` (PR 2, design section 11): sign a record body or a card with a signing
 * secret, and hash a signed record. Resolved by name at run time, so this file builds before that package exists.
 */
export interface RecordKit {
  signRecord(body: object, signSecret: Uint8Array): SignedRecord;
  signCard(card: object, signSecret: Uint8Array): SignedRecord;
  hashOf(record: SignedRecord): string;
}

const isSigned = (value: unknown): value is SignedRecord =>
  typeof value === "object" &&
  value !== null &&
  "body" in value &&
  "sig" in value &&
  typeof value.body === "string" &&
  typeof value.sig === "string";

function call(lib: Readonly<Record<string, unknown>>, name: string, args: readonly unknown[]): unknown {
  const fn = lib[name];
  if (typeof fn !== "function") throw new Error(`packages/mesh does not export ${name}`);
  return Reflect.apply(fn, undefined, args);
}

export function recordKit(lib: Readonly<Record<string, unknown>>): RecordKit {
  const signed = (name: string, args: readonly unknown[]): SignedRecord => {
    const result = call(lib, name, args);
    if (!isSigned(result)) throw new Error(`${name} did not return {body, sig}`);
    return result;
  };
  return {
    signRecord: (body, secret) => signed("signRecord", [body, secret]),
    signCard: (card, secret) => signed("signCard", [card, secret]),
    hashOf(record) {
      const hash = call(lib, "hashOf", [record]);
      if (typeof hash !== "string") throw new Error("hashOf did not return a string");
      return hash;
    },
  };
}

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

/** A `found` of a mesh of one, signed by `founder`: a second, foreign mesh's root. */
export function foundRecord(kit: RecordKit, founder: Actor): SignedRecord {
  const card = kit.signCard(
    {
      v: 1,
      mesh: "-",
      inviter: "-",
      nonce: base64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
      hostId: founder.keys.hostId,
      signPub: founder.signPub,
      noisePub: base64urlEncode(founder.keys.noise.publicKey),
      name: founder.name,
      hcId: founder.hcId,
    },
    founder.keys.sign.secretKey,
  );
  const body = { v: 2, mesh: "-", type: "found", by: founder.signPub, n: 1, prev: [], subject: { card } };
  return kit.signRecord(body, founder.keys.sign.secretKey);
}

/** The newest record `signPub` wrote in `records`: its counter and hash (the head a backdated chain continues from). */
export function lastOwn(
  kit: RecordKit,
  records: readonly SignedRecord[],
  signPub: string,
): { readonly n: number; readonly hash: string } {
  let best: { n: number; hash: string } | undefined;
  for (const record of records) {
    const body: unknown = JSON.parse(record.body);
    if (typeof body !== "object" || body === null || !("by" in body) || !("n" in body)) continue;
    if (body.by === signPub && typeof body.n === "number" && (best === undefined || body.n > best.n)) {
      best = { n: body.n, hash: kit.hashOf(record) };
    }
  }
  if (best === undefined) throw new Error(`no record by ${signPub}`);
  return best;
}

/** One signer's chain of records, each continuing the last: what an honest signer's counter and `prev` look like. */
export class Chain {
  readonly #kit: RecordKit;
  readonly #mesh: string;
  readonly #by: Actor;
  #n: number;
  #head: string;
  readonly written: SignedRecord[] = [];

  constructor(kit: RecordKit, mesh: string, by: Actor, from: { readonly n: number; readonly hash: string }) {
    this.#kit = kit;
    this.#mesh = mesh;
    this.#by = by;
    this.#n = from.n;
    this.#head = from.hash;
  }

  admit(subject: Actor, inviter: Actor = this.#by): string {
    const card = this.#kit.signCard(
      {
        v: 1,
        mesh: this.#mesh,
        inviter: inviter.signPub,
        nonce: base64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
        hostId: subject.keys.hostId,
        signPub: subject.signPub,
        noisePub: base64urlEncode(subject.keys.noise.publicKey),
        name: subject.name,
        hcId: subject.hcId,
      },
      subject.keys.sign.secretKey,
    );
    return this.#push("admit", { card });
  }

  revoke(...subjects: readonly Actor[]): string {
    return this.#push("revoke", { signPubs: subjects.map((subject) => subject.signPub), reason: "compromised" });
  }

  ack(after: string = this.#head): string {
    return this.#push("ack", undefined, [after]);
  }

  #push(type: string, subject: object | undefined, prev: readonly string[] = [this.#head]): string {
    this.#n += 1;
    const body = {
      v: 2,
      mesh: this.#mesh,
      type,
      by: this.#by.signPub,
      n: this.#n,
      prev,
      ...(subject === undefined ? {} : { subject }),
    };
    const record = this.#kit.signRecord(body, this.#by.keys.sign.secretKey);
    this.written.push(record);
    this.#head = this.#kit.hashOf(record);
    return this.#head;
  }
}
