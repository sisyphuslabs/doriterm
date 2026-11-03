import { base64urlEncode, type HostIdentity } from "@doriface/crypto";
import {
  type CardBody,
  door,
  hashOf,
  meshIdOf,
  parseRecord,
  type RecordBody,
  type Signed,
  signCard,
  signRecord,
  type View,
  viewOf,
} from "@doriface/mesh";
import { statSync } from "node:fs";
import { join } from "node:path";
import { AuthorizeIndex, indexOf } from "../mesh/authorize-index.ts";
import { DeviceStore } from "./devices.ts";
import { createPrivateJson, ensureStateDir, readJson, writePrivateJson } from "./files.ts";
import { KnownHosts } from "./known-hosts.ts";
import { DEFAULT_LOCK_TIMEOUT_MS, withStateLock } from "./lock.ts";
import { MESH_FILE, type MeshFile, meshFileJson, parseMeshFile } from "./mesh-file.ts";

export interface MeshStoreOptions {
  readonly log: (line: string) => void;
  /** The view function; tests pass a counting wrapper to prove a handshake never calls it. */
  readonly evaluate?: ((records: readonly Signed[]) => View) | undefined;
  readonly lockTimeoutMs?: number | undefined;
}

/** This host's own records are ahead of the counter it persisted: a restore from an older backup (section 10.1). */
export class CounterBehindError extends Error {
  override readonly name = "CounterBehindError";
}

export interface MergeResult {
  readonly added: readonly Signed[];
  readonly refused: readonly { readonly record: Signed; readonly reason: string }[];
}

/** The card a host puts in its own `found`, `admit` or `rekey`: everything but the mesh, inviter and nonce. */
export type OwnCard = Omit<CardBody, "v" | "mesh" | "inviter" | "nonce" | "hostId" | "signPub" | "noisePub">;

const heads = (records: readonly Signed[]): string[] => {
  const referenced = new Set(records.flatMap((record) => parseRecord(record)?.prev ?? []));
  return records.map(hashOf).filter((hash) => !referenced.has(hash));
};

/**
 * `mesh.json` under the state lock (sections 8.4 and 10.1). Every write evaluates the view once, persists the
 * authorize index with the records at a new `generation`, and in the same lock hold removes every paired device and
 * saved host that now belongs to a member or a revoked member. `authorizeIndex` never evaluates the view.
 */
export class MeshStore {
  readonly #dir: string;
  readonly #path: string;
  readonly #options: MeshStoreOptions;
  #cache: { readonly stamp: string; readonly index: AuthorizeIndex } | undefined;

  constructor(stateDir: string, options: MeshStoreOptions) {
    this.#dir = ensureStateDir(stateDir);
    this.#path = join(this.#dir, MESH_FILE);
    this.#options = options;
  }

  read(): MeshFile | undefined {
    const value = readJson(this.#path);
    return value === undefined ? undefined : parseMeshFile(value);
  }

  /**
   * The index of the current generation, for a handshake: re-read only when the file changed on disk, and taken from
   * the file as its writer persisted it. A file whose index is missing or stale is refused rather than evaluated.
   */
  authorizeIndex(): AuthorizeIndex | undefined {
    const stamp = this.#stamp();
    const cached = this.#cache;
    if (stamp !== undefined && cached?.stamp === stamp) return cached.index;
    const file = stamp === undefined ? undefined : this.read();
    if (stamp === undefined || file === undefined) {
      this.#cache = undefined;
      return undefined;
    }
    const index = cached?.index.generation === file.generation ? cached.index : persistedIndex(file);
    this.#cache = { stamp, index };
    return index;
  }

  /** Founds a mesh with this host's own card; false when a mesh.json already exists. */
  found(identity: HostIdentity, card: OwnCard): boolean {
    const body = cardBody(identity, card, "-", "-");
    const record = signRecord(foundBody(identity, signCard(body, identity.sign.secretKey)), identity.sign.secretKey);
    return this.#locked(() => this.#create(meshIdOf(record), [record], 1));
  }

  /** Stores a verified welcome as this host's new mesh.json; false when one appeared meanwhile (section 4.4). */
  adopt(records: readonly Signed[], identity: HostIdentity): boolean {
    const found = records.find((record) => parseRecord(record)?.type === "found");
    if (found === undefined) throw new Error("a welcome without a found record");
    const self = base64urlEncode(identity.sign.publicKey);
    const own = Math.max(0, ...records.flatMap((record) => ownN(record, self)));
    return this.#locked(() => this.#create(meshIdOf(found), records, own));
  }

  /** Runs each record through the door against the stored set and stores those it lets in, in one write. */
  merge(records: readonly Signed[]): MergeResult {
    return this.#locked(() => {
      const file = this.#require();
      const stored = [...file.records];
      const known = new Set(stored.map(hashOf));
      const added: Signed[] = [];
      const refused: { record: Signed; reason: string }[] = [];
      for (const record of records) {
        if (known.has(hashOf(record))) continue;
        const verdict = door(record, stored);
        if (!verdict.ok) {
          refused.push({ record, reason: verdict.reason });
          this.#options.log(`mesh: refused record ${hashOf(record)}: ${verdict.reason}`);
          continue;
        }
        stored.push(record);
        known.add(hashOf(record));
        added.push(record);
      }
      if (added.length > 0) this.#write({ ...file, records: stored });
      return { added, refused };
    });
  }

  /**
   * Signs this host's next record. Under the lock: refuses while the persisted counter is behind this host's own
   * records, persists the counter, and only then signs (`build` gets the counter and the heads) and stores.
   */
  sign(identity: HostIdentity, build: (n: number, prev: readonly string[]) => RecordBody): Signed {
    return this.#locked(() => {
      const file = this.#require();
      const self = base64urlEncode(identity.sign.publicKey);
      const own = Math.max(0, ...file.records.flatMap((record) => ownN(record, self)));
      if (file.selfN < own) {
        throw new CounterBehindError(
          `counter behind its records (file ${file.selfN}, mesh ${own}): syncing before signing`,
        );
      }
      const n = own + 1;
      const generation = file.generation + 1;
      const index = file.index === undefined ? undefined : { ...file.index, generation };
      const counted = { ...file, selfN: n, generation, index };
      writePrivateJson(this.#path, meshFileJson(counted));
      const record = signRecord(build(n, heads(file.records)), identity.sign.secretKey);
      const verdict = door(record, file.records);
      if (!verdict.ok) throw new Error(`this host's own record was refused: ${verdict.reason}`);
      this.#write({ ...counted, records: [...file.records, record] });
      return record;
    });
  }

  /** Raises the persisted counter to this host's own records, once sync showed no peer holds a later one. */
  catchUp(identity: HostIdentity): void {
    this.#locked(() => {
      const file = this.#require();
      const self = base64urlEncode(identity.sign.publicKey);
      const own = Math.max(0, ...file.records.flatMap((record) => ownN(record, self)));
      if (file.selfN < own) this.#write({ ...file, selfN: own });
    });
  }

  /** At start: rebuilds an index that is missing or stale, so handshakes find one for the current generation. */
  ensureIndex(): void {
    this.#locked(() => {
      const file = this.read();
      if (file !== undefined && file.index?.generation !== file.generation) this.#write(file);
    });
  }

  #create(meshId: string, records: readonly Signed[], selfN: number): boolean {
    const file: MeshFile = {
      meshId,
      generation: 1,
      selfN,
      records,
      dangling: [],
      local: {},
      notices: {},
      readOnlyUntil: null,
      index: undefined,
    };
    const indexed = this.#indexed(file);
    if (!createPrivateJson(this.#path, meshFileJson(indexed))) return false;
    this.#cleanup(indexed);
    return true;
  }

  /** Writes `file` at the next generation with its index, then cleans the device and known-host stores. */
  #write(file: MeshFile): void {
    const indexed = this.#indexed({ ...file, generation: file.generation + 1 });
    writePrivateJson(this.#path, meshFileJson(indexed));
    this.#cleanup(indexed);
  }

  #indexed(file: MeshFile): MeshFile {
    const view = (this.#options.evaluate ?? viewOf)(file.records);
    return { ...file, index: indexOf(file.records, view, file.generation) };
  }

  #cleanup(file: MeshFile): void {
    if (file.index === undefined) return;
    const { keys, hostIds } = new AuthorizeIndex(file.index).cleanup();
    for (const device of new DeviceStore(this.#dir).removeKeysHeld(keys)) {
      this.#options.log(`mesh: removed paired device "${device.name}": its key belongs to a mesh member`);
    }
    for (const hostId of new KnownHosts(this.#dir).removeHostsHeld(hostIds)) {
      this.#options.log(`mesh: removed saved host ${hostId}: the mesh reaches it now`);
    }
  }

  #require(): MeshFile {
    const file = this.read();
    if (file === undefined) throw new Error("this host is in no mesh");
    return file;
  }

  #stamp(): string | undefined {
    try {
      const stat = statSync(this.#path);
      return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  #locked<T>(fn: () => T): T {
    return withStateLock(this.#dir, fn, this.#options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  }
}

function persistedIndex(file: MeshFile): AuthorizeIndex {
  if (file.index?.generation !== file.generation) throw new Error(`${MESH_FILE}: its authorize index is stale`);
  return new AuthorizeIndex(file.index);
}

function ownN(record: Signed, self: string): number[] {
  const body = parseRecord(record);
  return body?.by === self ? [body.n] : [];
}

const nonce = (): string => base64urlEncode(crypto.getRandomValues(new Uint8Array(16)));

/** The card body for this host in mesh `mesh`, invited by `inviter` (both `"-"` in a found). */
export function cardBody(identity: HostIdentity, card: OwnCard, mesh: string, inviter: string, at = nonce()): CardBody {
  return {
    v: 1,
    mesh,
    inviter,
    nonce: at,
    hostId: identity.hostId,
    signPub: base64urlEncode(identity.sign.publicKey),
    noisePub: base64urlEncode(identity.noise.publicKey),
    ...card,
  };
}

const foundBody = (identity: HostIdentity, card: Signed): RecordBody => ({
  v: 2,
  mesh: "-",
  type: "found",
  by: base64urlEncode(identity.sign.publicKey),
  n: 1,
  prev: [],
  subject: { card },
});
