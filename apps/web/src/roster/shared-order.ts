import type { JsonObject } from "@doriface/protocol";
import {
  type DocCalls,
  type DocEdit,
  type DocState,
  DocWriteError,
  LayoutDoc,
  laterRank,
  mergedOrders,
  MOVED,
  type OrderRank,
  orderRank,
  readOrderDocument,
  stampOrder,
  storedOrder,
} from "@doriface/protocol/layout";

type Ready = Extract<DocState, { readonly phase: "ready" }>;

const sameRank = (a: OrderRank | null, b: OrderRank | null): boolean =>
  a !== null && b !== null && a.n === b.n && a.at === b.at && a.by === b.by;

/**
 * The person's machine order, one for every device whichever host carries the traffic (#2531). It is kept as the
 * `doriface` document on every machine's core, this core (`null`) and each connected added machine by permanent id, and
 * read from all of them: the copy holding the latest stamped write is the order (`orderRank`). A copy behind it (its
 * machine was away for that write) is brought up to it as soon as it is read, and the orders each core kept before the
 * order was shared become one stamped order, the routing core's first. A move is a stamped write to every copy, each a
 * compare-and-set; a copy another device moved meanwhile gets the move made again on its order, so both moves stay.
 */
export class SharedOrder {
  readonly #calls: DocCalls;
  readonly #changed: (state: DocState) => void;
  readonly #device: string;
  readonly #now: () => number;
  readonly #live = new Map<string | null, LayoutDoc>();
  /** The rank each copy is being brought up to, so a copy is not written twice for one write. */
  readonly #raising = new Map<string | null, OrderRank>();
  #state: DocState = { phase: "loading" };
  /** Whether machine.list has answered: until then the copies held are the routing core's only, not every machine's. */
  #listed = false;
  #fresh: { readonly from: string; readonly rank: OrderRank; readonly doc: JsonObject } | null = null;
  #wasSettled = false;

  constructor(
    calls: DocCalls,
    changed: (state: DocState) => void,
    device: string = crypto.randomUUID(),
    now: () => number = Date.now,
  ) {
    this.#calls = calls;
    this.#changed = changed;
    this.#device = device;
    this.#now = now;
  }

  /**
   * Whether every machine's copy is held and read, and none refuses a write: only then is "no order anywhere" a fact
   * rather than copies still on their way.
   */
  get settled(): boolean {
    const copies = [...this.#live.values()].map((doc) => doc.state.phase);
    return this.#listed && copies.length > 0 && copies.every((phase) => phase === "ready");
  }

  /** The order as one document: ready with the winning copy (or the merged per-core orders) once any copy is read. */
  get state(): DocState {
    return this.#state;
  }

  /**
   * Holds a copy per wanted machine, as LayoutDocs does; after a gap (`reread`) the held ones are read again. `listed`:
   * the ids come from a machine.list answer, so every machine's copy is wanted, not the routing core's alone (#2534 review).
   */
  sync(ids: ReadonlySet<string | null>, reread: boolean, listed = false): void {
    if (listed) this.#listed = true;
    let dropped = false;
    for (const id of this.#live.keys()) {
      if (ids.has(id)) continue;
      this.#live.delete(id);
      dropped = true;
    }
    for (const id of ids) {
      const held = this.#live.get(id);
      if (held !== undefined) {
        if (reread) void held.refresh();
        continue;
      }
      const doc = new LayoutDoc(this.#calls, id, () => this.#landed(), readOrderDocument);
      this.#live.set(id, doc);
      void doc.refresh();
    }
    // A machine read that leaves the copies as they were changes nothing, and tells no one (#2184).
    if (dropped) this.#landed();
  }

  /** Whether a copy of `id`'s order is held, so a doc event for it can be read now rather than kept for later. */
  holds(id: string | null): boolean {
    return this.#live.has(id);
  }

  heard(id: string | null, version: number): void {
    void this.#live.get(id)?.heard(version);
  }

  /**
   * Makes `change` on the order and writes it, stamped, to every copy that can take it. Resolves false when it no longer
   * applies; rejects with the routing core's reason when that copy refused it, or when no copy could be written.
   */
  async edit(change: DocEdit): Promise<boolean> {
    const state = this.#state;
    // A copy that cannot be read is never written over on a guess: the move waits until it is fixed or gone.
    const copies0 = [...this.#live.values()].map((doc) => doc.state);
    const refused = copies0.find((copy) => copy.phase === "unreadable");
    // Before the first stamped write, every core's order is still to be merged: a move made while one copy is not read
    // would stamp an order without it and later overwrite that copy unmerged (#2534 review), so it waits too.
    const unmerged =
      state.phase === "ready" && orderRank(state.doc) === null
        ? copies0.find((copy) => copy.phase !== "ready")
        : undefined;
    const blocked = refused ?? unmerged ?? (state.phase === "ready" ? undefined : state);
    if (blocked !== undefined) {
      const detail = blocked.phase === "loading" ? "it is still loading" : blocked.reason;
      throw new DocWriteError("unwritable", detail, `The layout cannot take changes now: ${detail}`);
    }
    if (state.phase !== "ready") return false;
    const next = change(state.doc);
    if (next === null) return false;
    const base = orderRank(state.doc);
    const rank = this.#rankAfter(base);
    const written = stampOrder(next, rank);
    const copies = [...this.#live].filter(([, doc]) => doc.state.phase === "ready");
    const results = await Promise.allSettled(
      copies.map(([, doc]) => doc.edit((current) => this.#onto(current, { written, base, rank }, change))),
    );
    const routing = results[copies.findIndex(([id]) => id === null)];
    if (routing?.status === "rejected") throw routing.reason;
    const done = results.find((result) => result.status === "fulfilled");
    if (done === undefined) throw results[0]?.status === "rejected" ? results[0].reason : new Error("no copy to write");
    return results.some((result) => result.status === "fulfilled" && result.value);
  }

  #rankAfter(...bases: readonly (OrderRank | null)[]): OrderRank {
    return { n: Math.max(0, ...bases.map((base) => base?.n ?? 0)) + 1, at: this.#now(), by: this.#device };
  }

  /**
   * This write on `current`: as made when the copy holds the order it was made on or an older one; made again on the
   * copy's own order, counted past both, when another device wrote it since, so neither move is lost (#2005).
   */
  #onto(
    current: JsonObject | null,
    write: { readonly written: JsonObject; readonly base: OrderRank | null; readonly rank: OrderRank },
    change: DocEdit,
  ): JsonObject | null {
    const held = orderRank(current);
    if (sameRank(held, write.rank)) return null;
    if (held === null || sameRank(held, write.base) || laterRank(write.base, held)) return write.written;
    const again = change(current);
    return again === null ? null : stampOrder(again, this.#rankAfter(held, write.rank));
  }

  #landed(): void {
    const ready = [...this.#live].flatMap(([id, doc]) =>
      doc.state.phase === "ready" ? [{ id, state: doc.state }] : [],
    );
    const next = this.#merged(ready);
    // Readers are told only when the order they read changes, or when it becomes settled: a copy dropped or read again
    // with the same order is not news.
    const settled = this.settled;
    const same = JSON.stringify(next) === JSON.stringify(this.#state) && settled === this.#wasSettled;
    this.#state = next;
    this.#wasSettled = settled;
    if (!same) this.#changed(next);
    this.#bringUp(ready);
  }

  #merged(ready: readonly { readonly id: string | null; readonly state: Ready }[]): DocState {
    if (ready.length === 0) return this.#live.get(null)?.state ?? { phase: "loading" };
    const winner = this.#winner(ready);
    if (winner !== null) return { phase: "ready", doc: winner, version: 0 };
    const order = mergedOrders(this.#routingFirst(ready).map(({ state }) => state.doc));
    return { phase: "ready", doc: order === null ? null : { machine_order: [...order] }, version: 0 };
  }

  #winner(ready: readonly { readonly state: Ready }[]): JsonObject | null {
    let best: JsonObject | null = null;
    for (const { state } of ready) if (laterRank(orderRank(state.doc), orderRank(best))) best = state.doc;
    return best;
  }

  #routingFirst<T extends { readonly id: string | null }>(ready: readonly T[]): readonly T[] {
    return ready.toSorted((a, b) => (a.id === null ? -1 : b.id === null ? 1 : a.id.localeCompare(b.id)));
  }

  /**
   * Every copy behind the order is written up to it. With no stamped write anywhere yet, the merged per-core orders are
   * stamped and written once every held copy has been read, so no core's order is merged in after the write.
   */
  #bringUp(ready: readonly { readonly id: string | null; readonly state: Ready }[]): void {
    const state = this.#state;
    if (state.phase !== "ready" || state.doc === null) return;
    let target = state.doc;
    let rank = orderRank(target);
    if (rank === null) {
      // The per-core orders are merged once: only when every machine's copy is held and read, never on the routing
      // core's alone, or the others' orders would count as behind and be overwritten unmerged.
      // A copy whose read failed is not read either: merging without it would overwrite its order unmerged (#2534 review).
      if (!this.#listed || [...this.#live.values()].some((doc) => doc.state.phase !== "ready")) return;
      rank = this.#rankAfter(null);
      target = stampOrder(target, rank);
    } else {
      // A machine that was offline at the one-time merge joins later with its own unstamped order: merged in, not
      // overwritten (#2534 review).
      const late = ready.filter(({ state: copy }) => orderRank(copy.doc) === null && storedOrder(copy.doc) !== null);
      const merged = late.length === 0 ? null : mergedOrders([target, ...late.map(({ state: copy }) => copy.doc)]);
      const grown = merged !== null && merged.length > (storedOrder(target) ?? []).length;
      // An older client's move ranks only one past the write it was made on, so its next move would tie with copies of
      // this one: it is stamped afresh, and every copy, the one it was made on too, is brought up (#2534 review).
      if (grown || rank.by.startsWith(MOVED)) {
        // Stamped once per order it starts from, so a bring-up run again before the writes land writes the same one.
        const from = JSON.stringify([rank, grown ? merged : storedOrder(target)]);
        if (this.#fresh?.from !== from) {
          const fresh = this.#rankAfter(rank);
          this.#fresh = {
            from,
            rank: fresh,
            doc: stampOrder(grown ? { ...target, machine_order: [...merged] } : target, fresh),
          };
        }
        rank = this.#fresh.rank;
        target = this.#fresh.doc;
      }
    }
    const goal = rank;
    const value = target;
    const behind = ready.filter(
      ({ id, state: copy }) => laterRank(goal, orderRank(copy.doc)) && !sameRank(this.#raising.get(id) ?? null, goal),
    );
    // A fresh stamp is made from one copy's order: that copy is written first, and the others only once it took the
    // write unchanged, so an older client's move landing there meanwhile is read and ranked again instead of being
    // outranked by a stamp made without it (#2534 review).
    const read = JSON.stringify(state.doc);
    const origin =
      state.doc === target ? undefined : ready.find(({ state: copy }) => JSON.stringify(copy.doc) === read);
    // While that copy's write is on its way (a bring-up run again as another copy is read), the others wait for it.
    if (origin !== undefined && sameRank(this.#raising.get(origin.id) ?? null, goal)) return;
    const source = origin === undefined ? undefined : behind.find((entry) => entry.id === origin.id);
    const rest = behind.filter((entry) => entry !== source);
    if (source === undefined) for (const entry of rest) void this.#raise(entry, goal, value);
    else void this.#raiseAfter(source, rest, goal, value);
  }

  async #raiseAfter(
    source: { readonly id: string | null; readonly state: Ready },
    rest: readonly { readonly id: string | null; readonly state: Ready }[],
    goal: OrderRank,
    value: JsonObject,
  ): Promise<void> {
    if (!(await this.#raise(source, goal, value))) return;
    // The source's write lands as a publish that runs bring-up again, which may already be raising these copies.
    for (const entry of rest)
      if (!sameRank(this.#raising.get(entry.id) ?? null, goal)) void this.#raise(entry, goal, value);
  }

  /** Writes `value` over one copy only as it was read: a write that landed since is read first and ranked again. */
  async #raise(
    { id, state: copy }: { readonly id: string | null; readonly state: Ready },
    goal: OrderRank,
    value: JsonObject,
  ): Promise<boolean> {
    const doc = this.#live.get(id);
    if (doc === undefined) return false;
    const seen = JSON.stringify(copy.doc);
    this.#raising.set(id, goal);
    try {
      return await doc.edit(
        (current) => (JSON.stringify(current) === seen && laterRank(goal, orderRank(current)) ? value : null),
        "once saved",
      );
    } catch {
      return false;
    } finally {
      if (sameRank(this.#raising.get(id) ?? null, goal)) this.#raising.delete(id);
    }
  }
}
