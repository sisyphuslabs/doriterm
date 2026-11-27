import { base64urlEncode, type HostIdentity } from "@doriface/crypto";
import {
  meshIdOf,
  parseRecord,
  type RecordBody,
  type Signed,
  signCard,
  signRecord,
  type View,
  viewOf,
} from "@doriface/mesh";
import { JoinRefused, type OwnCard } from "@doriface/mesh/join";
import { join } from "node:path";
import type { AuthorizeIndex } from "../mesh/authorize-index.ts";
import { createPrivateJson, ensureStateDir, fileStamp, writePrivateJson } from "./files.ts";
import { DEFAULT_LOCK_TIMEOUT_MS, withStateLock } from "./lock.ts";
import { recordClientSession } from "./client-session-record.ts";
import { cleanupAfterWrite, withIndex } from "./mesh-cleanup.ts";
import { MESH_FILE, type MeshFile, meshFileJson, newMeshFile } from "./mesh-file.ts";
import { readMeshFile, unreadableMesh } from "./mesh-read.ts";
import { cardBody, foundBody, persistedIndex } from "./mesh-records.ts";
import { type MergeResult, type MeshTx, ownN, Transaction } from "./mesh-tx.ts";

export { CounterBehindError, type MergeResult, type MeshTx } from "./mesh-tx.ts";
export { cardBody } from "./mesh-records.ts";

export interface MeshStoreOptions {
  readonly log: (line: string) => void;
  /** The view function; tests pass a counting wrapper to prove a handshake never calls it. */
  readonly evaluate?: ((records: readonly Signed[]) => View) | undefined;
  readonly lockTimeoutMs?: number | undefined;
  /**
   * False skips flushing mesh.json to disk on each write; each write stays atomic. For in-memory test meshes, whose run
   * time would otherwise follow the disk's flush latency (#91). Default true.
   */
  readonly durable?: boolean | undefined;
}

export type { OwnCard };

export interface MeshCandidate {
  readonly file: MeshFile;
  readonly committed: boolean;
}

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
  #candidate: { file: MeshFile; users: number; committed: boolean } | undefined;
  /** The file stamp an unreadable mesh.json was last reported at. */
  #unreadable: string | undefined;

  constructor(stateDir: string, options: MeshStoreOptions) {
    this.#dir = ensureStateDir(stateDir);
    this.#path = join(this.#dir, MESH_FILE);
    this.#options = options;
  }

  /**
   * The mesh file, or undefined when this host is in no mesh it can use: none exists, or one that cannot be read or
   * parsed (#2951), which is said once per change on disk and never written over: every write follows a read of the
   * file or creates one only where none exists. Joins and offers ask `unreadable` first and refuse with its reason.
   */
  read(): MeshFile | undefined {
    const state = readMeshFile(this.#path);
    if (state.kind === "file") return state.file;
    if (state.kind === "unreadable") {
      const stamp = fileStamp(this.#path);
      if (stamp !== this.#unreadable) {
        this.#unreadable = stamp;
        this.#options.log(`mesh: ${unreadableMesh(this.#path, state.reason)}; this host runs as in no mesh until then`);
      }
    }
    return undefined;
  }

  /** Why mesh.json cannot be used, or undefined when it can (or there is none). */
  unreadable(): string | undefined {
    const state = readMeshFile(this.#path);
    return state.kind === "unreadable" ? unreadableMesh(this.#path, state.reason) : undefined;
  }

  /** Best-effort local observation, at most once per client per five minutes; never waits for a busy state lock. */
  recordClientSession(devicePub: string, at = Date.now()): void {
    recordClientSession(
      {
        dir: this.#dir,
        path: this.#path,
        durable: this.#options.durable ?? true,
        index: () => this.authorizeIndex(),
        read: () => this.read(),
        log: this.#options.log,
      },
      devicePub,
      at,
    );
  }

  /**
   * The index of the current generation, for a handshake: re-read only when the file changed on disk, and taken from
   * the file as its writer persisted it, never from an earlier file (a replaced mesh.json starts again at generation
   * 1). A file whose index is missing or stale is refused rather than evaluated.
   */
  authorizeIndex(): AuthorizeIndex | undefined {
    const stamp = fileStamp(this.#path);
    const cached = this.#cache;
    if (stamp !== undefined && cached?.stamp === stamp) return cached.index;
    const file = stamp === undefined ? undefined : this.read();
    if (stamp === undefined || file === undefined) {
      this.#cache = undefined;
      return undefined;
    }
    const index = persistedIndex(file);
    this.#cache = { stamp, index };
    return index;
  }

  /** Founds a mesh with this host's own card; false when a mesh.json already exists. */
  found(identity: HostIdentity, card: OwnCard): boolean {
    const body = cardBody(identity, card, "-", "-");
    const record = signRecord(foundBody(identity, signCard(body, identity.sign.secretKey)), identity.sign.secretKey);
    return this.#locked(() => this.#create(meshIdOf(record), [record], 1));
  }

  /** Shares a founding candidate while the first admission decisions are outstanding, without persisting it. */
  prepareFound(identity: HostIdentity, card: OwnCard): { candidate: MeshCandidate; release: () => void } {
    this.#observeCommitted(this.read());
    let candidate = this.#candidate;
    if (candidate === undefined || candidate.committed) {
      const body = cardBody(identity, card, "-", "-");
      const record = signRecord(foundBody(identity, signCard(body, identity.sign.secretKey)), identity.sign.secretKey);
      candidate = {
        file: this.#indexed(newMeshFile(meshIdOf(record), [record], 1)),
        users: 0,
        committed: false,
      };
      this.#candidate = candidate;
    }
    candidate.users++;
    let released = false;
    return {
      candidate,
      release: () => {
        if (released) return;
        released = true;
        candidate.users--;
        if (candidate.users === 0 && this.#candidate === candidate) this.#candidate = undefined;
      },
    };
  }

  /** Only the advisory approval document may read this; authorization and sync use the persisted file. */
  pendingFoundForStatus(): MeshFile | undefined {
    return this.#candidate?.committed === false ? this.#candidate.file : undefined;
  }

  /** Stores a verified welcome as this host's new mesh.json; false when one appeared meanwhile (section 4.4). */
  adopt(records: readonly Signed[], identity: HostIdentity): boolean {
    const found = records.find((record) => parseRecord(record)?.type === "found");
    if (found === undefined) throw new Error("a welcome without a found record");
    const own = ownN(records, base64urlEncode(identity.sign.publicKey));
    return this.#locked(() => this.#create(meshIdOf(found), records, own));
  }

  /**
   * One read-modify-write of mesh.json under the state lock: `fn` merges, reads the view and signs through `tx`,
   * and what it changed is written once at the next generation with its index, and the device and known-host stores
   * cleaned, in the same hold. Nothing `fn` merged after its last signature is written if it throws; a counter it persisted stays, with
   * the records and held pool it was derived from.
   */
  transact<T>(fn: (tx: MeshTx) => T, rollback?: () => void, initial?: MeshCandidate): T {
    return this.#locked(() => {
      const stored = this.read();
      this.#observeCommitted(stored);
      if (initial !== undefined && (stored === undefined ? initial.committed : stored.meshId !== initial.file.meshId)) {
        throw new JoinRefused("the mesh changed while the join was pending");
      }
      const founding = stored === undefined && initial !== undefined;
      const tx = new Transaction(stored ?? initial?.file ?? this.#require(), {
        evaluate: this.#evaluate,
        // A candidate emits no signature before atomic creation; existing meshes reserve counters on disk.
        persistCounter: (file, selfN, view) =>
          founding ? { ...file, selfN } : this.#persistCounter(file, selfN, view),
        log: this.#options.log,
      });
      try {
        const value = fn(tx);
        const next = tx.commit();
        if (founding) {
          if (next === undefined) throw new JoinRefused("a first join must admit a member before founding its mesh");
          if (!this.#create(next.file.meshId, next.file.records, next.file.selfN))
            throw new JoinRefused("the mesh changed while the join was pending");
        } else if (next !== undefined) this.#write(next.file, next.view);
        return value;
      } catch (error) {
        rollback?.();
        throw error;
      }
    });
  }

  /** Runs the dangling pool and `records` through the door; admitted records are stored, held ones kept in the pool. */
  merge(records: readonly Signed[]): MergeResult {
    return this.transact((tx) => tx.merge(records));
  }

  /** Signs this host's next record (`build` gets the counter and the heads), the counter persisted first. */
  sign(identity: HostIdentity, build: (n: number, prev: readonly string[]) => RecordBody): Signed {
    return this.transact((tx) => tx.sign(identity, build));
  }

  /** Raises the persisted counter to this host's own records, once sync showed no peer holds a later one. */
  catchUp(identity: HostIdentity): void {
    this.#locked(() => {
      const file = this.#require();
      const own = ownN(file.records, base64urlEncode(identity.sign.publicKey));
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

  /** A file holding the candidate's mesh means it was committed, by this store or another one (#1635). */
  #observeCommitted(file: MeshFile | undefined): void {
    if (file !== undefined && this.#candidate?.file.meshId === file.meshId) this.#candidate.committed = true;
  }

  #create(meshId: string, records: readonly Signed[], selfN: number): boolean {
    const file: MeshFile = newMeshFile(meshId, records, selfN);
    const indexed = this.#indexed(file);
    if (!createPrivateJson(this.#path, meshFileJson(indexed), this.#options.durable ?? true)) return false;
    this.#observeCommitted(indexed);
    this.#cleanup(indexed);
    return true;
  }

  /** Writes `file` at the next generation with its index, then cleans the device and known-host stores. */
  #write(file: MeshFile, view?: View): void {
    const indexed = this.#indexed({ ...file, generation: file.generation + 1 }, view);
    writePrivateJson(this.#path, meshFileJson(indexed), this.#options.durable ?? true);
    this.#cleanup(indexed);
  }

  /**
   * Persists the counter at the next generation (section 10.1), with the records it was derived from. An index that
   * is current for exactly these records keeps its content; a stale or missing one (the caller drops it when it
   * merged records) is rebuilt, never re-tagged as current.
   */
  #persistCounter(file: MeshFile, selfN: number, view?: View): MeshFile {
    const generation = file.generation + 1;
    const current = file.index !== undefined && file.index.generation === file.generation;
    const counted = current
      ? { ...file, selfN, generation, index: file.index === undefined ? undefined : { ...file.index, generation } }
      : this.#indexed({ ...file, selfN, generation }, view);
    writePrivateJson(this.#path, meshFileJson(counted), this.#options.durable ?? true);
    if (!current) this.#cleanup(counted);
    return counted;
  }

  #indexed(file: MeshFile, view = this.#evaluate(file.records)): MeshFile {
    return withIndex(file, view, this.read());
  }

  readonly #evaluate = (records: readonly Signed[]): View => (this.#options.evaluate ?? viewOf)(records);

  #cleanup(file: MeshFile): void {
    cleanupAfterWrite(this.#dir, file, this.#options.log);
  }

  #require(): MeshFile {
    const file = this.read();
    if (file === undefined) throw new Error("this host is in no mesh");
    return file;
  }

  #locked<T>(fn: () => T): T {
    return withStateLock(this.#dir, fn, this.#options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  }
}
