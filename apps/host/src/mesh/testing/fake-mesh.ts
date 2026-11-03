import { isRecord } from "../../state/files.ts";
import type {
  DoorVerdict,
  MeshFile,
  MeshMember,
  MeshRecord,
  MeshRules,
  MeshSigner,
  MeshState,
  MeshView,
  RecordDraft,
  RecordHeader,
  RecordType,
  Transaction,
} from "../upstream.ts";

/**
 * Stand-ins for `@doriface/mesh` and `state/mesh.ts` in sync's tests: the same record shape and set semantics (hash
 * links, the door's dangling hold, grow-only union), with a plain admitted-minus-revoked view instead of rule R3.
 * Signatures are a hash tag, so a tampered body is refused.
 */
export const MESH_ID = "testmeshtestmeshtestmeshte";
const MAX_MEMBERS = 12;

export function member(name: string): MeshMember {
  return {
    signPub: `sign-${name}`,
    hostId: `${name}host`.padEnd(25, "x") + "a",
    noisePub: `noise-${name}`,
    name,
    hcId: `hc-${name}`,
  };
}

const hashOf = (body: string): string => new Bun.CryptoHasher("sha256").update(body).digest("hex");

function seal(body: Record<string, unknown>): MeshRecord {
  const text = JSON.stringify(body);
  return { body: text, sig: `fake:${hashOf(text)}` };
}

export function found(founder: MeshMember): MeshRecord {
  return seal({ v: 2, mesh: "-", type: "found", by: founder.signPub, n: 1, prev: [], subject: { card: founder } });
}

interface Bodied {
  readonly mesh: string;
  readonly type: RecordType;
  readonly by: string;
  readonly n: number;
  readonly prev: readonly string[];
  readonly subject: unknown;
}

function parse(record: MeshRecord): Bodied {
  const value: unknown = JSON.parse(record.body);
  if (!isRecord(value)) throw new Error("not a record body");
  const { mesh, type, by, n, prev, subject } = value;
  if (typeof mesh !== "string" || typeof by !== "string" || typeof n !== "number" || !Array.isArray(prev)) {
    throw new Error("malformed record body");
  }
  const types: readonly RecordType[] = ["found", "admit", "revoke", "name", "rekey", "ack"];
  const known = types.find((entry) => entry === type);
  if (known === undefined) throw new Error("unknown record type");
  return { mesh, type: known, by, n, prev: prev.map(String), subject };
}

const cardOf = (subject: unknown): MeshMember | undefined => {
  if (!isRecord(subject) || !isRecord(subject["card"])) return undefined;
  const card = subject["card"];
  const field = (key: string): string => String(card[key]);
  return {
    signPub: field("signPub"),
    hostId: field("hostId"),
    noisePub: field("noisePub"),
    name: field("name"),
    hcId: field("hcId"),
  };
};

const revokesOf = (subject: unknown): readonly string[] =>
  isRecord(subject) && Array.isArray(subject["signPubs"]) ? subject["signPubs"].map(String) : [];

function headerOf(record: MeshRecord): RecordHeader {
  const body = parse(record);
  const revokes = body.type === "revoke" ? revokesOf(body.subject) : [];
  return { hash: hashOf(record.body), type: body.type, by: body.by, n: body.n, prev: body.prev, revokes };
}

function door(record: MeshRecord, stored: readonly MeshRecord[]): DoorVerdict {
  let body: Bodied;
  try {
    body = parse(record);
  } catch (error) {
    return { kind: "refused", reason: String(error) };
  }
  if (record.sig !== `fake:${hashOf(record.body)}`) return { kind: "refused", reason: "bad signature" };
  if (body.type === "found") {
    return stored.length === 0 ? { kind: "ok" } : { kind: "refused", reason: "a second found" };
  }
  if (body.mesh !== MESH_ID) return { kind: "refused", reason: "another mesh" };
  const hashes = new Set(stored.map((entry) => hashOf(entry.body)));
  const missing = body.prev.filter((hash) => !hashes.has(hash));
  if (missing.length > 0) return { kind: "dangling", missing };
  const signers = new Set(stored.flatMap((entry) => [cardOf(parse(entry).subject)?.signPub ?? ""]));
  return signers.has(body.by) ? { kind: "ok" } : { kind: "dangling", missing: [] };
}

function viewOf(records: readonly MeshRecord[]): MeshView {
  const members = new Map<string, MeshMember>();
  const revoked = new Set<string>();
  for (const record of records) {
    const body = parse(record);
    const card = cardOf(body.subject);
    if ((body.type === "found" || body.type === "admit") && card !== undefined && !revoked.has(card.signPub)) {
      members.set(card.signPub, card);
    }
    for (const key of body.type === "revoke" ? revokesOf(body.subject) : []) {
      revoked.add(key);
      members.delete(key);
    }
  }
  const all = [...members.values()];
  return { members: all.slice(0, MAX_MEMBERS), overCap: all.slice(MAX_MEMBERS), revoked: [...revoked] };
}

function headsOf(records: readonly MeshRecord[]): readonly string[] {
  const named = new Set(records.flatMap((record) => parse(record).prev));
  return records.map((record) => hashOf(record.body)).filter((hash) => !named.has(hash));
}

function missingFor(records: readonly MeshRecord[], peerHeads: readonly string[]): readonly MeshRecord[] {
  const byHash = new Map(records.map((record) => [hashOf(record.body), record]));
  const past = new Set<string>();
  const stack = peerHeads.filter((hash) => byHash.has(hash));
  for (let hash = stack.pop(); hash !== undefined; hash = stack.pop()) {
    if (past.has(hash)) continue;
    past.add(hash);
    const record = byHash.get(hash);
    if (record !== undefined) stack.push(...parse(record).prev);
  }
  return records.filter((record) => !past.has(hashOf(record.body)));
}

export const fakeRules: MeshRules = { headerOf, door, viewOf, headsOf, missingFor };

/** `mesh.json` in memory. Transactions never nest (the state lock) and every commit is kept for inspection. */
export class MemoryFile implements MeshFile {
  #state: MeshState;
  #inside = false;
  readonly commits: MeshState[] = [];

  constructor(records: readonly MeshRecord[]) {
    this.#state = { records, dangling: [] };
  }

  read(): MeshState {
    return this.#state;
  }

  transact<T>(change: (state: MeshState) => Transaction<T>): T {
    if (this.#inside) throw new Error("the state lock is already held");
    this.#inside = true;
    try {
      const { state, result } = change(this.#state);
      this.#state = state;
      this.commits.push(state);
      return result;
    } finally {
      this.#inside = false;
    }
  }
}

export class FakeSigner implements MeshSigner {
  readonly signPub: string;
  #n: number;

  constructor(self: MeshMember, n = 1) {
    this.signPub = self.signPub;
    this.#n = n;
  }

  sign(draft: RecordDraft): MeshRecord {
    this.#n += 1;
    const base = { v: 2, mesh: MESH_ID, type: draft.type, by: this.signPub, n: this.#n, prev: draft.prev };
    if (draft.type === "ack") return seal(base);
    return seal({ ...base, subject: { signPubs: draft.signPubs, reason: draft.reason } });
  }

  admit(subject: MeshMember, prev: readonly string[]): MeshRecord {
    this.#n += 1;
    return seal({ v: 2, mesh: MESH_ID, type: "admit", by: this.signPub, n: this.#n, prev, subject: { card: subject } });
  }

  name(prev: readonly string[], name: string): MeshRecord {
    this.#n += 1;
    const subject = { signPub: this.signPub, name };
    return seal({ v: 2, mesh: MESH_ID, type: "name", by: this.signPub, n: this.#n, prev, subject });
  }
}

export const hashOfRecord = (record: MeshRecord): string => hashOf(record.body);

/** A founded mesh of `members`, the founder admitting the rest in a chain. */
export function meshOf(members: readonly MeshMember[]): readonly MeshRecord[] {
  const [founder, ...rest] = members;
  if (founder === undefined) throw new Error("a mesh needs a founder");
  const records: MeshRecord[] = [found(founder)];
  const signer = new FakeSigner(founder);
  for (const joiner of rest) records.push(signer.admit(joiner, headsOf(records)));
  return records;
}
