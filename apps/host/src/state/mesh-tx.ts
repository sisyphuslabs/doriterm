import { base64urlEncode, type HostIdentity } from "@doriface/crypto";
import {
  door,
  hashOf,
  mergeAtDoor,
  parseRecord,
  type RecordBody,
  type Signed,
  signRecord,
  type View,
} from "@doriface/mesh";
import type { MeshFile } from "./mesh-file.ts";

/** This host's own records are ahead of the counter it persisted: a restore from an older backup (section 10.1). */
export class CounterBehindError extends Error {
  override readonly name = "CounterBehindError";
}

export interface MergeResult {
  readonly added: readonly Signed[];
  readonly refused: readonly { readonly record: Signed; readonly reason: string }[];
  /** Held records the dangling pool's cap evicted, oldest first. */
  readonly dropped: readonly Signed[];
}

/** One read-modify-write of mesh.json, inside one state-lock hold (sections 5.5 and 8.4). */
export interface MeshTx {
  /** The stored records, with what this transaction merged or signed appended. */
  readonly records: readonly Signed[];
  /** The held records (design 3.3 steps 4-5), at most `MAX_DANGLING`. */
  readonly dangling: readonly Signed[];
  /** Runs the dangling pool and then `incoming` through the door against the records so far. */
  merge(incoming: readonly Signed[]): MergeResult;
  /** The view of the records so far, evaluated once per change. */
  view(): View;
  /** Signs this host's next record on the current heads; the counter is persisted before the signature exists. */
  sign(identity: HostIdentity, build: (n: number, prev: readonly string[]) => RecordBody): Signed;
}

export interface TxDeps {
  readonly evaluate: (records: readonly Signed[]) => View;
  /** Persists `selfN` (and nothing else of this transaction) and returns the file as written. */
  readonly persistCounter: (file: MeshFile, selfN: number) => MeshFile;
  readonly log: (line: string) => void;
}

export const ownN = (records: readonly Signed[], self: string): number =>
  Math.max(0, ...records.flatMap((record) => (parseRecord(record)?.by === self ? [parseRecord(record)?.n ?? 0] : [])));

export const headsOf = (records: readonly Signed[]): string[] => {
  const referenced = new Set(records.flatMap((record) => parseRecord(record)?.prev ?? []));
  return records.map(hashOf).filter((hash) => !referenced.has(hash));
};

export class Transaction implements MeshTx {
  #disk: MeshFile;
  #records: readonly Signed[];
  #dangling: readonly Signed[];
  #view: { readonly records: readonly Signed[]; readonly view: View } | undefined;
  #changed = false;
  readonly #deps: TxDeps;

  constructor(file: MeshFile, deps: TxDeps) {
    this.#disk = file;
    this.#records = file.records;
    this.#dangling = file.dangling;
    this.#deps = deps;
  }

  get records(): readonly Signed[] {
    return this.#records;
  }

  get dangling(): readonly Signed[] {
    return this.#dangling;
  }

  merge(incoming: readonly Signed[]): MergeResult {
    const known = new Set(this.#records.map(hashOf));
    const merged = mergeAtDoor(
      this.#records,
      this.#dangling,
      incoming.filter((record) => !known.has(hashOf(record))),
    );
    for (const { record, reason } of merged.refused)
      this.#deps.log(`mesh: refused record ${hashOf(record)}: ${reason}`);
    for (const record of merged.dropped)
      this.#deps.log(`mesh: dropped held record ${hashOf(record)}: the pool is full`);
    const poolChanged =
      merged.dangling.length !== this.#dangling.length ||
      merged.dangling.some((record, i) => record !== this.#dangling[i]);
    if (merged.added.length > 0 || poolChanged) this.#changed = true;
    this.#records = merged.stored;
    this.#dangling = merged.dangling;
    return { added: merged.added, refused: merged.refused, dropped: merged.dropped };
  }

  view(): View {
    if (this.#view?.records !== this.#records)
      this.#view = { records: this.#records, view: this.#deps.evaluate(this.#records) };
    return this.#view.view;
  }

  sign(identity: HostIdentity, build: (n: number, prev: readonly string[]) => RecordBody): Signed {
    const own = ownN(this.#records, base64urlEncode(identity.sign.publicKey));
    if (this.#disk.selfN < own) {
      throw new CounterBehindError(
        `counter behind its records (file ${this.#disk.selfN}, mesh ${own}): syncing before signing`,
      );
    }
    this.#disk = this.#deps.persistCounter(this.#disk, own + 1);
    const record = signRecord(build(own + 1, headsOf(this.#records)), identity.sign.secretKey);
    const verdict = door(record, this.#records);
    if (!verdict.ok) throw new Error(`this host's own record was refused: ${verdict.reason}`);
    this.#records = [...this.#records, record];
    this.#changed = true;
    return record;
  }

  /** What to commit, with the view when it was evaluated on exactly these records; undefined when nothing changed. */
  commit(): { readonly file: MeshFile; readonly view: View | undefined } | undefined {
    if (!this.#changed) return undefined;
    const file = { ...this.#disk, records: this.#records, dangling: this.#dangling };
    return { file, view: this.#view?.records === this.#records ? this.#view.view : undefined };
  }
}
