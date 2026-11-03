// The engine state that outlives one evaluation: results about records and their pasts, which no later record can
// change, and the evaluations of contexts (see the header of engine.ts). Engines over sets of one History share it.

import type { History } from "./chain.ts";
import type { RecordSet } from "./dag.ts";
import type { EngineView } from "./membership.ts";
import type { Status } from "./status.ts";

/** One evaluation of a context: its view and the statuses of its non-ack records. */
export interface Core {
  readonly view: EngineView;
  readonly statuses: ReadonlyMap<string, Status>;
}

type Tables = Map<string, Map<string, unknown>>;

export class Shared {
  readonly history: History;
  readonly #once: Tables = new Map();
  readonly #perSet = new WeakMap<RecordSet, Tables>();
  readonly #heads = new WeakMap<ReadonlySet<string>, readonly string[]>();
  readonly #before = new Map<string, EngineView | undefined>();
  readonly #members = new Map<string, ReadonlySet<string>>();
  /** context -> the first set evaluated with it, which stands for every set with that context. */
  readonly #contexts = new Map<string, RecordSet>();
  readonly #cores = new Map<string, Core>();
  readonly #growing = new Map<string, { readonly list: string[]; scanned: number }>();

  constructor(history: History) {
    this.history = history;
  }

  static table(tables: Tables, kind: string): Map<string, unknown> {
    let t = tables.get(kind);
    if (t === undefined) {
      t = new Map();
      tables.set(kind, t);
    }
    return t;
  }

  static memo<T>(store: Map<string, unknown>, key: string, compute: () => T): T {
    // A key is only ever stored by the computation that names it, so its value has that computation's type.
    if (store.has(key)) return store.get(key) as T;
    const value = compute();
    store.set(key, value);
    return value;
  }

  once<T>(kind: string, key: string, compute: () => T): T {
    return Shared.memo(Shared.table(this.#once, kind), key, compute);
  }

  /**
   * The records of `source` (an append-only list of the history) that pass `test`, extended by the records appended
   * since the last call. Callers filter the result by their set, so records outside it are harmless.
   */
  growing(key: string, source: readonly string[], test: (id: string) => boolean): readonly string[] {
    let entry = this.#growing.get(key);
    if (entry === undefined) {
      entry = { list: [], scanned: 0 };
      this.#growing.set(key, entry);
    }
    for (; entry.scanned < source.length; entry.scanned++) {
      const id = source[entry.scanned];
      if (id !== undefined && test(id)) entry.list.push(id);
    }
    return entry.list;
  }

  cached<T>(S: RecordSet, kind: string, key: string, compute: () => T): T {
    let tables = this.#perSet.get(S);
    if (tables === undefined) {
      tables = new Map();
      this.#perSet.set(S, tables);
    }
    return Shared.memo(Shared.table(tables, kind), key, compute);
  }

  headsOf(S: ReadonlySet<string>, compute: () => readonly string[]): readonly string[] {
    const known = this.#heads.get(S);
    if (known !== undefined) return known;
    const heads = compute();
    this.#heads.set(S, heads);
    return heads;
  }

  before(id: string, compute: () => EngineView | undefined): EngineView | undefined {
    if (this.#before.has(id)) return this.#before.get(id);
    const view = compute();
    this.#before.set(id, view);
    return view;
  }

  membersBefore(id: string, compute: () => ReadonlySet<string>): ReadonlySet<string> {
    const known = this.#members.get(id);
    if (known !== undefined) return known;
    const members = compute();
    this.#members.set(id, members);
    return members;
  }

  /** The evaluation of `context`, made with S the first time; `set` is the set it was made with. */
  core(S: RecordSet, context: string, compute: (set: RecordSet) => Core): { set: RecordSet; core: Core } {
    const set = this.#contexts.get(context) ?? S;
    let core = this.#cores.get(context);
    if (core === undefined) {
      this.#contexts.set(context, set);
      core = compute(set);
      this.#cores.set(context, core);
    }
    return { set, core };
  }
}
