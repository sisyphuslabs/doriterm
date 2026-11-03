// The engine state that outlives one evaluation: results about records and their pasts, which no later record can
// change, and the evaluations of contexts (see the header of engine.ts). Engines over sets of one History share it.
// Nothing here may hold an Engine, a Dag or a closure over one: a ViewCache keeps this for a mesh's life, and each
// merge builds a new Dag of the whole set.

import type { History } from "./chain.ts";
import type { PastSet, RecordSet } from "./dag.ts";
import { type MemberView, type RuleView, ruleViewOf } from "./membership.ts";
import type { Status } from "./status.ts";

/** One evaluation of a context: its view and the statuses of its non-ack records, plain data. */
export interface Evaluation {
  readonly view: MemberView;
  readonly statuses: ReadonlyMap<string, Status>;
}

/** The statuses of the last full view's context: the only ones kept, because only a full view reads eff. */
interface Decided {
  readonly context: string;
  readonly evaluation: Evaluation;
}

type Tables = Map<string, Map<string, unknown>>;

export class Shared {
  readonly history: History;
  readonly #once: Tables = new Map();
  readonly #perSet = new WeakMap<RecordSet, Tables>();
  readonly #heads = new WeakMap<PastSet, readonly string[]>();
  readonly #before = new Map<string, RuleView | undefined>();
  readonly #members = new Map<string, ReadonlySet<string>>();
  /** The rule view of each set evaluated so far, under the set's heads, and of each context. No statuses. */
  readonly #views = new Map<string, RuleView>();
  readonly #contexts = new Map<string, RuleView>();
  #decided: Decided | undefined;
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

  headsOf(S: PastSet, compute: () => readonly string[]): readonly string[] {
    const known = this.#heads.get(S);
    if (known !== undefined) return known;
    const heads = compute();
    this.#heads.set(S, heads);
    return heads;
  }

  before(id: string, compute: () => RuleView | undefined): RuleView | undefined {
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

  /** The view of the set with these heads: the one of its context, evaluated once with the first such set. */
  view(heads: string, context: () => string, evaluate: () => Evaluation): RuleView {
    const known = this.#views.get(heads);
    if (known !== undefined) return known;
    const key = context();
    let view = this.#contexts.get(key);
    if (view === undefined) {
      view = ruleViewOf(evaluate().view);
      this.#contexts.set(key, view);
    }
    this.#views.set(heads, view);
    return view;
  }

  /**
   * A full view's evaluation with its statuses. A merge that leaves the context as it was (an ack that witnesses no
   * conflict) reuses the last one; any other context is evaluated again, and replaces it.
   */
  decide(heads: string, context: string, evaluate: () => Evaluation): Evaluation {
    if (this.#decided?.context !== context) {
      const evaluation = evaluate();
      this.#decided = { context, evaluation };
      if (!this.#contexts.has(context)) this.#contexts.set(context, ruleViewOf(evaluation.view));
    }
    const { evaluation } = this.#decided;
    if (!this.#views.has(heads)) this.#views.set(heads, this.#contexts.get(context) ?? ruleViewOf(evaluation.view));
    return evaluation;
  }
}
