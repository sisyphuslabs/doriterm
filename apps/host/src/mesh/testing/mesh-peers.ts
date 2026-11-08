import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashOf, meshIdOf, parseRecord, type RecordBody, type Signed, signRecord, type Subject } from "@doriface/mesh";
import { MeshStore, type MeshStoreOptions } from "../../state/mesh.ts";
import { headsOf, ownN } from "../../state/mesh-tx.ts";
import {
  cardFor,
  deviceOf,
  type Machine,
  machine,
  MeshFixture,
  noiseOf,
  signPubOf,
} from "../../testing/mesh-history.ts";
import type { MemberEntry } from "../authorize-index.ts";

const ROOT = mkdtempSync(join(tmpdir(), "mesh-peers-"));
process.once("exit", () => rmSync(ROOT, { recursive: true, force: true }));
let dirs = 0;
const scratch = (): string => mkdtempSync(join(ROOT, `${dirs++}-`));

/** A host as sync's tests use it: its keys, and its member entry as a view would list it. */
export interface Peer extends MemberEntry {
  readonly machine: Machine;
}

const peers = new Map<string, Peer>();

/** The peer called `name`, the same one on every call in this process. */
export function peer(name: string): Peer {
  const known = peers.get(name);
  if (known !== undefined) return known;
  const m = machine(name);
  const made: Peer = {
    machine: m,
    signPub: signPubOf(m),
    hostId: m.identity.hostId,
    noisePub: noiseOf(m),
    devicePub: deviceOf(m),
    kind: "machine",
    name,
    hcId: m.hcId,
  };
  peers.set(name, made);
  return made;
}

/** A mesh the first peer founded and that admitted the rest in order; its records and id. */
export function meshOf(members: readonly Peer[]): { readonly records: readonly Signed[]; readonly meshId: string } {
  const [founder, ...rest] = members;
  if (founder === undefined) throw new Error("a mesh needs a founder");
  const fixture = new MeshFixture(scratch(), founder.machine);
  fixture.admitAll(
    founder.machine,
    rest.map((joiner) => joiner.machine),
  );
  const records = fixture.store.read()?.records ?? [];
  return { records, meshId: fixture.meshId };
}

export const meshIdOfRecords = (records: readonly Signed[]): string => {
  const found = records.find((record) => parseRecord(record)?.type === "found");
  if (found === undefined) throw new Error("no found record");
  return meshIdOf(found);
};

/**
 * `owner`'s own mesh.json, holding `records`, in a fresh state dir. Its writes are not flushed to disk: these meshes
 * test gossip and views, not crash safety, and a flush per write made their run time follow the disk (#91).
 */
export function storeOf(owner: Peer, records: readonly Signed[], options: Partial<MeshStoreOptions> = {}): MeshStore {
  const store = new MeshStore(scratch(), { log: () => undefined, durable: false, ...options });
  if (!store.adopt(records, owner.machine.identity)) throw new Error("a mesh already exists here");
  return store;
}

/** Signs `by`'s records with counters of its own, as a member that keeps writing without merging them yet. */
export class Signer {
  readonly #by: Peer;
  readonly #meshId: string;
  #n: number;

  constructor(by: Peer, records: readonly Signed[]) {
    this.#by = by;
    this.#meshId = meshIdOfRecords(records);
    this.#n = ownN(records, by.signPub);
  }

  admit(joiner: Peer, prev: readonly string[]): Signed {
    return this.#sign("admit", prev, { card: cardFor(joiner.machine, this.#meshId, this.#by.machine) });
  }

  name(prev: readonly string[], name: string): Signed {
    return this.#sign("name", prev, { signPub: this.#by.signPub, name });
  }

  ack(prev: readonly string[]): Signed {
    return this.#sign("ack", prev);
  }

  revoke(prev: readonly string[], ...subjects: readonly Peer[]): Signed {
    return this.#sign("revoke", prev, { signPubs: subjects.map((entry) => entry.signPub), reason: "revoke" });
  }

  #sign(type: RecordBody["type"], prev: readonly string[], subject?: Subject): Signed {
    this.#n += 1;
    const body: RecordBody = {
      v: 2,
      mesh: this.#meshId,
      type,
      by: this.#by.signPub,
      n: this.#n,
      prev,
      ...(subject === undefined ? {} : { subject }),
    };
    return signRecord(body, this.#by.machine.identity.sign.secretKey);
  }
}

export const headsOfRecords = (records: readonly Signed[]): readonly string[] => headsOf(records);
export const hashes = (records: readonly Signed[]): readonly string[] => records.map(hashOf);
