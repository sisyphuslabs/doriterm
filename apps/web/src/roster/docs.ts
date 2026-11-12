import type { JsonObject } from "@doriface/protocol";
import { type DocCalls, type DocState, LayoutDoc, readDocument } from "@doriface/protocol/layout";
import { diffSpaces, type SpaceChange } from "./changes.ts";
import { type Schedule, timers } from "./feed.ts";
import { Reread } from "./reread.ts";

export interface LayoutDocsOptions {
  /** The document's reading rules: herdr-app's layout by default. */
  readonly read?: typeof readDocument;
  /** Whether a failed read may be read again now (Reread): the roster is in use on an open connection. */
  readonly reading?: () => boolean;
  /** When a failed read is read again (Reread); real timers by default. */
  readonly schedule?: Schedule;
}

/**
 * The herdr-app layout document of this core (`null`) and of every connected added machine, by permanent machine id.
 * A document is read when its machine is first wanted, again on each `doc` event naming it, and all of them again on a
 * gap, as hc asks (schema/README.md, Documents: documents are not in snapshots and changes in a gap are not replayed).
 * Every read that lands is diffed against the one before by space id. The last document read from a machine is kept
 * after the machine drops, so its tabs stay on screen read-only. A read that fails is read again by itself (Reread).
 */
export class LayoutDocs {
  readonly #calls: DocCalls;
  readonly #landed: (changes: readonly SpaceChange[]) => void;
  readonly #read: typeof readDocument;
  readonly #reading: () => boolean;
  readonly #schedule: Schedule;
  readonly #live = new Map<string | null, LayoutDoc>();
  readonly #rereads = new Map<string | null, Reread>();
  readonly #kept = new Map<string | null, JsonObject | null>();
  readonly #shown = new Map<string | null, JsonObject | null>();

  /** `landed` runs on every state a document publishes (loading, ready, unreadable, unavailable), with what changed. */
  constructor(calls: DocCalls, landed: (changes: readonly SpaceChange[]) => void, options: LayoutDocsOptions = {}) {
    this.#calls = calls;
    this.#landed = landed;
    this.#read = options.read ?? readDocument;
    this.#reading = options.reading ?? (() => true);
    this.#schedule = options.schedule ?? timers;
  }

  stateOf(id: string | null): DocState | undefined {
    return this.#live.get(id)?.state;
  }

  live(id: string | null): LayoutDoc | undefined {
    return this.#live.get(id);
  }

  /** The last document read from that machine, even once it dropped; undefined when none was ever read. */
  kept(id: string | null): JsonObject | null | undefined {
    return this.#kept.get(id);
  }

  /**
   * Keeps a document per wanted machine: a newly wanted one is read now, one no longer wanted loses its live document
   * (kept stays). After a gap (`reread`) the ones already held are read again too, whatever version this page holds.
   */
  sync(ids: ReadonlySet<string | null>, reread: boolean): void {
    for (const id of this.#live.keys()) {
      if (ids.has(id)) continue;
      this.#live.delete(id);
      this.#rereads.get(id)?.stop();
      this.#rereads.delete(id);
    }
    for (const id of ids) {
      const held = this.#live.get(id);
      if (held !== undefined) {
        if (reread) void held.refresh();
        continue;
      }
      const doc = new LayoutDoc(this.#calls, id, (state) => this.#published(id, state), this.#read);
      this.#live.set(id, doc);
      this.#rereads.set(id, new Reread(() => void doc.refresh(), this.#reading, this.#schedule));
      void doc.refresh();
    }
  }

  heard(id: string | null, version: number): void {
    void this.#live.get(id)?.heard(version);
  }

  clear(): void {
    this.#live.clear();
    for (const reread of this.#rereads.values()) reread.stop();
    this.#rereads.clear();
  }

  #published(id: string | null, state: DocState): void {
    if (this.#live.get(id)?.state !== state) return;
    if (state.phase === "unavailable") this.#rereads.get(id)?.failed();
    else this.#rereads.get(id)?.landed();
    if (state.phase !== "ready") return this.#landed([]);
    this.#kept.set(id, state.doc);
    const before = this.#shown.get(id);
    this.#shown.set(id, state.doc);
    this.#landed(diffSpaces(id, before ?? null, state.doc));
  }
}
