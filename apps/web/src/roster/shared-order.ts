import type { JsonObject } from "@doriface/protocol";
import {
  type DocCalls,
  type DocEdit,
  type DocState,
  DocWriteError,
  LayoutDoc,
  laterRank,
  mergedOrders,
  type OrderRank,
  orderRank,
  readOrderDocument,
  stampOrder,
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

  /** The order as one document: ready with the winning copy (or the merged per-core orders) once any copy is read. */
  get state(): DocState {
    return this.#state;
  }

  /** Holds a copy per wanted machine, as LayoutDocs does; after a gap (`reread`) the held ones are read again. */
  sync(ids: ReadonlySet<string | null>, reread: boolean): void {
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
    const refused = [...this.#live.values()].map((doc) => doc.state).find((copy) => copy.phase === "unreadable");
    const blocked = refused ?? (state.phase === "ready" ? undefined : state);
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
    // Readers are told only when the order they read changes: a copy dropped or read again with the same order is not news.
    const same = JSON.stringify(next) === JSON.stringify(this.#state);
    this.#state = next;
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
      if ([...this.#live.values()].some((doc) => doc.state.phase === "loading")) return;
      rank = this.#rankAfter(null);
      target = stampOrder(target, rank);
    }
    for (const { id, state: copy } of ready) {
      if (!laterRank(rank, orderRank(copy.doc)) || sameRank(this.#raising.get(id) ?? null, rank)) continue;
      const doc = this.#live.get(id);
      if (doc === undefined) continue;
      const goal = rank;
      const value = target;
      this.#raising.set(id, goal);
      void doc
        .edit((current) => (laterRank(goal, orderRank(current)) ? value : null), "once saved")
        .catch(() => undefined)
        .finally(() => {
          if (sameRank(this.#raising.get(id) ?? null, goal)) this.#raising.delete(id);
        });
    }
  }
}
