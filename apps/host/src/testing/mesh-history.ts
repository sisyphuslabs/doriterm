import {
  base64urlEncode,
  generateHostIdentity,
  generateX25519,
  type HostIdentity,
  type KeyPair,
} from "@doriface/crypto";
import { hashOf, parseRecord, type RecordBody, type Signed, signCard, signRecord, type Subject } from "@doriface/mesh";
import { cardBody, MeshStore } from "../state/mesh.ts";

/** A machine as the mesh sees it: its host keys, its #30 device key, and its herdr core. */
export interface Machine {
  readonly identity: HostIdentity;
  readonly device: KeyPair;
  readonly name: string;
  readonly hcId: string;
}

export const machine = (name: string): Machine => ({
  identity: generateHostIdentity(),
  device: generateX25519(),
  name,
  hcId: crypto.randomUUID().replaceAll("-", ""),
});

export const signPubOf = (m: Machine): string => base64urlEncode(m.identity.sign.publicKey);
export const noiseOf = (m: Machine): string => base64urlEncode(m.identity.noise.publicKey);
export const deviceOf = (m: Machine): string => base64urlEncode(m.device.publicKey);

/** `m`'s card for `meshId`, naming `inviter` (itself for a rekey), with `identity`'s Noise key. */
export function cardFor(m: Machine, meshId: string, inviter: Machine, identity = m.identity): Signed {
  const own = { name: m.name, hcId: m.hcId, devicePub: deviceOf(m) };
  return signCard(cardBody(identity, own, meshId, signPubOf(inviter)), identity.sign.secretKey);
}

/**
 * A mesh founded by `founder` in `dir`, whose records any member can sign: each record takes its signer's next
 * counter and every current head as `prev`, as a host writing with full knowledge does.
 */
export class MeshFixture {
  readonly store: MeshStore;
  readonly founder: Machine;
  readonly logs: string[] = [];

  constructor(dir: string, founder: Machine) {
    this.founder = founder;
    // Not flushed to disk: fixtures test mesh logic, not crash safety, and a flush per write made them follow the disk (#91).
    this.store = new MeshStore(dir, { log: (line) => void this.logs.push(line), durable: false });
    const own = { name: founder.name, hcId: founder.hcId, devicePub: deviceOf(founder) };
    if (!this.store.found(founder.identity, own)) throw new Error("a mesh already exists here");
  }

  get meshId(): string {
    return this.#file().meshId;
  }

  /** The body `by` would sign next, without storing it. */
  next(by: Machine, type: RecordBody["type"], subject?: Subject): RecordBody {
    const records = this.#file().records;
    const by64 = signPubOf(by);
    const n = 1 + Math.max(0, ...records.map((record) => parseRecord(record)).map((b) => (b?.by === by64 ? b.n : 0)));
    const referenced = new Set(records.flatMap((record) => parseRecord(record)?.prev ?? []));
    const prev = records.map(hashOf).filter((hash) => !referenced.has(hash));
    return { v: 2, mesh: this.meshId, type, by: by64, n, prev, ...(subject === undefined ? {} : { subject }) };
  }

  record(by: Machine, type: RecordBody["type"], subject?: Subject): Signed {
    const record = signRecord(this.next(by, type, subject), by.identity.sign.secretKey);
    const { refused } = this.store.merge([record]);
    if (refused.length > 0) throw new Error(`the fixture's own record was refused: ${refused[0]?.reason}`);
    return record;
  }

  admit(by: Machine, joiner: Machine): Signed {
    return this.record(by, "admit", { card: cardFor(joiner, this.meshId, by) });
  }

  /**
   * `by` admits each of `joiners` in order, each admit on the one before, as `admit` one at a time would sign them,
   * merged in one transaction: one view evaluation and one write for the chain, where one merge per admit re-evaluated
   * the whole log each time.
   */
  admitAll(by: Machine, joiners: readonly Machine[]): readonly Signed[] {
    const first = this.next(by, "admit");
    const admits: Signed[] = [];
    let prev = first.prev;
    for (const [i, joiner] of joiners.entries()) {
      const subject = { card: cardFor(joiner, this.meshId, by) };
      const record = signRecord({ ...first, n: first.n + i, prev, subject }, by.identity.sign.secretKey);
      admits.push(record);
      prev = [hashOf(record)];
    }
    const { added } = this.store.merge(admits);
    if (added.length !== admits.length) throw new Error("the fixture's own admits were not all stored");
    return admits;
  }

  revoke(by: Machine, ...subjects: Machine[]): Signed {
    return this.record(by, "revoke", { signPubs: subjects.map(signPubOf), reason: "revoke" });
  }

  /** `m` changes its Noise key to `noise` (same signing key): a self-signed rekey. */
  rekey(m: Machine, noise: KeyPair): Signed {
    const identity = { ...m.identity, noise };
    return this.record(m, "rekey", { card: cardFor(m, this.meshId, m, identity) });
  }

  #file() {
    const file = this.store.read();
    if (file === undefined) throw new Error("no mesh");
    return file;
  }
}
