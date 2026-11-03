// Turns an abstract scenario into real signed records: one deterministic Ed25519 key per key name, member cards signed
// by their subjects, and prev links as real record hashes. Used to run shapes through the door and viewOf.

import { base64urlEncode, hostIdOf } from "@doriface/crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hashOf, meshIdOf, signCard, signRecord } from "../../src/records/codec.ts";
import type { RecordBody, Signed, Subject } from "../../src/records/types.ts";
import type { Rec } from "../../src/view/dag.ts";

const encoder = new TextEncoder();
const bytes = (label: string, length = 32): Uint8Array =>
  sha256(encoder.encode(`doriface-mesh test ${label}`)).subarray(0, length);

/** The Noise key a card with the abstract noise label `label` carries once signed. */
export const noiseOf = (label: string): string => base64urlEncode(bytes(`noise ${label}`));

export interface TestKey {
  readonly name: string;
  readonly secret: Uint8Array;
  readonly pub: string;
  readonly hostId: string;
}

export function keyOf(name: string): TestKey {
  const secret = bytes(`key ${name}`);
  const pub = ed25519.getPublicKey(secret);
  return { name, secret, pub: base64urlEncode(pub), hostId: hostIdOf(pub) };
}

export interface SignedScenario {
  readonly records: readonly Signed[];
  readonly byId: ReadonlyMap<string, Signed>;
  readonly nameOfKey: ReadonlyMap<string, string>;
}

/**
 * Signs `records` (in topological order, with counters) as real v1.5 records of one mesh. A card names its subject's
 * key and is signed by `card.by`, so a card whose `by` is not its subject is a forgery the door refuses.
 */
export function signScenario(records: readonly Rec[]): SignedScenario {
  const keys = new Map<string, TestKey>();
  const key = (name: string): TestKey => {
    const known = keys.get(name) ?? keyOf(name);
    keys.set(name, known);
    return known;
  };
  const byId = new Map<string, Signed>();
  let mesh = "-";
  const out: Signed[] = [];
  for (const r of records) {
    const signer = key(r.by);
    let subject: Subject | undefined;
    if (r.card !== undefined) {
      const k = key(r.subject ?? r.card.by);
      const inviter = r.type === "found" ? "-" : key(r.card.inviter).pub;
      const body = {
        v: 1,
        mesh,
        inviter,
        nonce: base64urlEncode(bytes(`nonce ${r.card.nonce}`, 16)),
        hostId: k.hostId,
        signPub: k.pub,
        noisePub: noiseOf(r.card.noise),
        name: r.card.name,
        hcId: `core-${r.card.name}`,
      } as const;
      subject = { card: signCard(body, key(r.card.by).secret) };
    } else if (r.subjects !== undefined) {
      subject = { signPubs: r.subjects.map((s) => key(s).pub), reason: "revoke" };
    } else if (r.type === "name" && r.subject !== undefined && r.name !== undefined) {
      subject = { signPub: key(r.subject).pub, name: r.name };
    }
    const prev = r.prev.map((p) => {
      const parent = byId.get(p);
      if (parent === undefined) throw new RangeError(`${r.id}: prev ${p} is not signed yet (records out of order)`);
      return hashOf(parent);
    });
    const body: RecordBody = {
      v: 2,
      mesh,
      type: r.type,
      by: signer.pub,
      n: r.n,
      prev,
      ...(subject === undefined ? {} : { subject }),
    };
    const signed = signRecord(body, signer.secret);
    if (r.type === "found") mesh = meshIdOf(signed);
    byId.set(r.id, signed);
    out.push(signed);
  }
  return { records: out, byId, nameOfKey: new Map([...keys.values()].map((k) => [k.pub, k.name])) };
}
