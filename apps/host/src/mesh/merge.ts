import type { MeshFile, MeshRecord, MeshRules, MeshSigner, MeshState, MeshView } from "./upstream.ts";

/** Section 3.3: the dangling pool holds at most 256 records, the oldest dropped first. */
export const MAX_DANGLING = 256;
/** Section 3.3: the set holds at most 4096 records. */
export const MAX_RECORDS = 4096;
/** Section 5.2: a record names at most 64 heads; more are first merged by `ack` records. */
export const MAX_PREV = 64;

/** A peer holds a later record of this host's own than this host does: a restore from an older backup (10.1). */
export class CounterBehindError extends Error {
  override readonly name = "CounterBehindError";
}

export interface Refusal {
  readonly hash: string;
  readonly reason: string;
}

export interface MergeResult {
  /** Records stored by this merge, in the order stored, this host's own acks included. */
  readonly added: readonly MeshRecord[];
  readonly refused: readonly Refusal[];
  /** Hashes the dangling pool still waits for. */
  readonly wanted: readonly string[];
  /** The ack this merge wrote (section 5.5), if any. */
  readonly ack: MeshRecord | undefined;
  /** This host's counter is behind a peer's `hello.n`, so it signed nothing (section 10.1). */
  readonly counterBehind: boolean;
  readonly view: MeshView;
}

export interface MergeDeps {
  readonly file: MeshFile;
  readonly rules: MeshRules;
  readonly signer: MeshSigner;
  /** The highest `n` of this host's key in any peer's `hello`: below it, this host signs nothing (section 10.1). */
  readonly counterFloor?: number;
}

const MEMBERSHIP = new Set(["admit", "revoke", "rekey"]);

interface Pending {
  readonly records: MeshRecord[];
  readonly dangling: Map<string, MeshRecord>;
  readonly added: MeshRecord[];
  readonly refused: Refusal[];
  readonly wanted: Set<string>;
}

/** Stores every record the door admits, retrying held ones until nothing more fits. */
function admit(deps: MergeDeps, pending: Pending, incoming: readonly MeshRecord[]): void {
  const { rules } = deps;
  const known = new Set(pending.records.map((record) => rules.headerOf(record).hash));
  let queue = [...pending.dangling.values(), ...incoming];
  pending.dangling.clear();
  let progressed = true;
  while (progressed) {
    progressed = false;
    const held: MeshRecord[] = [];
    for (const record of queue) {
      const hash = rules.headerOf(record).hash;
      if (known.has(hash)) continue;
      const verdict = rules.door(record, pending.records);
      if (verdict.kind === "ok" && pending.records.length < MAX_RECORDS) {
        pending.records.push(record);
        pending.added.push(record);
        known.add(hash);
        progressed = true;
      } else if (verdict.kind === "ok") {
        pending.refused.push({ hash, reason: `mesh log full (${MAX_RECORDS})` });
      } else if (verdict.kind === "dangling") {
        held.push(record);
      } else {
        pending.refused.push({ hash, reason: verdict.reason });
      }
    }
    queue = held;
  }
  for (const record of queue.slice(-MAX_DANGLING)) {
    pending.dangling.set(rules.headerOf(record).hash, record);
    const verdict = rules.door(record, pending.records);
    if (verdict.kind === "dangling") for (const hash of verdict.missing) pending.wanted.add(hash);
  }
}

const hasRoom = (pending: Pending): boolean => pending.records.length < MAX_RECORDS;

/** The highest `n` of this host's own records in the set, when that is below the floor a peer reported. */
function behindBy(deps: MergeDeps, records: readonly MeshRecord[]): number | undefined {
  const floor = deps.counterFloor ?? 0;
  const self = deps.signer.signPub;
  let own = 0;
  for (const record of records) {
    const header = deps.rules.headerOf(record);
    if (header.by === self) own = Math.max(own, header.n);
  }
  return own < floor ? own : undefined;
}

/** Writes acks until every head fits in one `prev`, then returns the heads; undefined when the log fills first. */
function fitHeads(deps: MergeDeps, pending: Pending): readonly string[] | undefined {
  let heads = deps.rules.headsOf(pending.records);
  while (heads.length > MAX_PREV) {
    if (!hasRoom(pending)) return undefined;
    const merged = deps.signer.sign({ type: "ack", prev: heads.slice(0, MAX_PREV) });
    pending.records.push(merged);
    pending.added.push(merged);
    heads = deps.rules.headsOf(pending.records);
  }
  return hasRoom(pending) ? heads : undefined;
}

/** A membership record signed by someone else is acked once, by a member that is valid in the merged view. */
function needsAck(deps: MergeDeps, added: readonly MeshRecord[], view: MeshView): boolean {
  const self = deps.signer.signPub;
  if (!view.members.some((member) => member.signPub === self)) return false;
  return added.some((record) => {
    const header = deps.rules.headerOf(record);
    return header.by !== self && MEMBERSHIP.has(header.type);
  });
}

/**
 * Merges a batch in one transaction under the state lock (section 5.5): the door, the dangling pool, the view, and the
 * automatic ack. Writing the ack in the same transaction is what lets no interleaved merge separate it from the batch.
 */
export function mergeBatch(deps: MergeDeps, batch: readonly MeshRecord[]): MergeResult {
  return deps.file.transact((state: MeshState) => {
    const pending: Pending = {
      records: [...state.records],
      dangling: new Map(state.dangling.map((record) => [deps.rules.headerOf(record).hash, record])),
      added: [],
      refused: [],
      wanted: new Set(),
    };
    admit(deps, pending, batch);
    let view = deps.rules.viewOf(pending.records);
    let ack: MeshRecord | undefined;
    const counterBehind = behindBy(deps, pending.records) !== undefined;
    const acks = needsAck(deps, pending.added, view) && !counterBehind;
    const prev = acks ? fitHeads(deps, pending) : undefined;
    if (prev !== undefined) {
      ack = deps.signer.sign({ type: "ack", prev });
      pending.records.push(ack);
      pending.added.push(ack);
      view = deps.rules.viewOf(pending.records);
    }
    const next: MeshState = { records: pending.records, dangling: [...pending.dangling.values()] };
    const result: MergeResult = {
      added: pending.added,
      refused: pending.refused,
      wanted: [...pending.wanted],
      ack,
      counterBehind,
      view,
    };
    return { state: next, result };
  });
}

/** Signs one record of this host's own (a revoke, a leave) in a transaction, after fitting its heads. */
export function appendOwn(
  deps: MergeDeps,
  draft: (prev: readonly string[]) => Parameters<MeshSigner["sign"]>[0],
): MergeResult {
  return deps.file.transact((state: MeshState) => {
    const own = behindBy(deps, state.records);
    if (own !== undefined) {
      const floor = deps.counterFloor ?? 0;
      throw new CounterBehindError(`counter behind its records (mesh ${floor}, here ${own}): syncing before signing`);
    }
    const pending: Pending = {
      records: [...state.records],
      dangling: new Map(),
      added: [],
      refused: [],
      wanted: new Set(),
    };
    const prev = fitHeads(deps, pending);
    if (prev === undefined) throw new Error(`mesh log full (${MAX_RECORDS})`);
    const record = deps.signer.sign(draft(prev));
    pending.records.push(record);
    pending.added.push(record);
    const view = deps.rules.viewOf(pending.records);
    const result: MergeResult = {
      added: pending.added,
      refused: [],
      wanted: [],
      ack: undefined,
      counterBehind: false,
      view,
    };
    return { state: { records: pending.records, dangling: state.dangling }, result };
  });
}
