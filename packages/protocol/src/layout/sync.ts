import { type JsonObject, type JsonValue } from "../json.ts";
import { HcRpcError } from "../jsonrpc.ts";
import { readDocument, type ReadDocument } from "./document.ts";

export interface DocCalls {
  readonly get: (on: string | null) => Promise<{ readonly value: JsonValue; readonly version: number }>;
  readonly set: (on: string | null, value: JsonValue, version: number) => Promise<{ readonly version: number }>;
}

export type DocState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly doc: JsonObject | null; readonly version: number }
  | { readonly phase: "unreadable"; readonly reason: string; readonly version: number }
  | { readonly phase: "unavailable"; readonly reason: string };

/** An edit of the whole document: null when it no longer applies (its target went away), and nothing is written. */
export type DocEdit = (doc: JsonObject | null) => JsonObject | null;

/**
 * When an edit reaches the screen: `at once` as it is written (what a person does shows without a round trip), or
 * `once saved`, only as the host took it. An edit no person made that names new ids (adopting loose terminals) is shown
 * once saved: another device may make the same edit with other ids first, and a list keyed by ids this one dropped on
 * the conflict would drop what was open on them (#1572).
 */
export type EditShown = "at once" | "once saved";

const CONFLICT_RETRIES = 8;
const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
const isConflict = (cause: unknown): boolean => cause instanceof HcRpcError && cause.kind === "conflict";
const unwritable = (state: Exclude<DocState, { readonly phase: "ready" }>): string =>
  state.phase === "loading" ? "it is still loading" : state.reason;

/**
 * Why an edit was not saved, for a caller that words it in its own document's terms: the document kept changing on
 * another device through every retry (`conflict`), or it cannot take writes now (`unwritable`: loading, unreadable or
 * not reachable), with `detail` saying which. The message stays the layout's own wording.
 */
export class DocWriteError extends Error {
  readonly kind: "conflict" | "unwritable";
  readonly detail: string;

  constructor(kind: "conflict" | "unwritable", detail: string, message: string) {
    super(message);
    this.name = "DocWriteError";
    this.kind = kind;
    this.detail = detail;
  }
}

/**
 * One machine's herdr-app document, kept the way herdr-app keeps it (`src/mirror_sync.rs`): read with `doc.get`, every
 * write a compare-and-set at the version that was read, and a conflict re-reads the document and replaces ours with it.
 * Unlike herdr-app, which writes its whole model, doriface writes edits: after a conflict the person's edit is made
 * again on the fresh document, or dropped when it no longer applies. Writes go one at a time, in order. `read` gives
 * the document's reading rules: herdr-app's by default; another document kept the same way (doriface's own) brings its own.
 */
export class LayoutDoc {
  readonly #calls: DocCalls;
  readonly #on: string | null;
  readonly #changed: (state: DocState) => void;
  readonly #read: (value: JsonValue) => ReadDocument;
  #state: DocState = { phase: "loading" };
  #reads = 0;
  #queue: Promise<unknown> = Promise.resolve();
  #writing = 0;
  /** The newest version a doc event named while our writes were in flight: read once they are done. */
  #missed = -1;

  constructor(
    calls: DocCalls,
    on: string | null,
    changed: (state: DocState) => void,
    read: (value: JsonValue) => ReadDocument = readDocument,
  ) {
    this.#calls = calls;
    this.#on = on;
    this.#changed = changed;
    this.#read = read;
  }

  get state(): DocState {
    return this.#state;
  }

  #publish(state: DocState): void {
    this.#state = state;
    this.#changed(state);
  }

  /** Reads the document; a read that an edit or a later read overtook is not shown. */
  async refresh(): Promise<void> {
    const read = ++this.#reads;
    try {
      const { value, version } = await this.#calls.get(this.#on);
      if (read === this.#reads) this.#show(value, version);
    } catch (cause) {
      if (read === this.#reads) this.#publish({ phase: "unavailable", reason: reasonOf(cause) });
    }
  }

  #show(value: JsonValue, version: number): void {
    const read = this.#read(value);
    if (read.kind === "unreadable") this.#publish({ phase: "unreadable", reason: read.reason, version });
    else this.#publish({ phase: "ready", doc: read.kind === "ok" ? read.doc : null, version });
  }

  /**
   * A `doc` event: another client wrote the document, so read it unless this one wrote that version. While a write is
   * in flight the event can name a version past ours before our reply arrives; it is kept and read once writing ends.
   */
  heard(version: number): Promise<void> {
    if (version === this.#known()) return Promise.resolve();
    if (this.#writing === 0) return this.refresh();
    this.#missed = Math.max(this.#missed, version);
    return Promise.resolve();
  }

  #known(): number {
    return this.#state.phase === "ready" ? this.#state.version : -1;
  }

  /**
   * Applies an edit and writes it; resolves false when the edit no longer applies (nothing is written), and rejects with
   * the reason when the document cannot take it: not readable or loaded, or changed by others past every retry.
   */
  edit(change: DocEdit, shown: EditShown = "at once"): Promise<boolean> {
    const run = this.#queue.then(() => this.#write(change, shown));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #write(change: DocEdit, shown: EditShown): Promise<boolean> {
    this.#writing += 1;
    try {
      return await this.#attempt(change, shown, CONFLICT_RETRIES);
    } finally {
      this.#writing -= 1;
      const missed = this.#missed;
      if (this.#writing === 0 && missed !== -1) {
        this.#missed = -1;
        if (missed > this.#known()) await this.refresh();
      }
    }
  }

  async #attempt(change: DocEdit, shown: EditShown, left: number): Promise<boolean> {
    // A re-read that failed once (a dropped link, a doc.get past its deadline on a loaded host) leaves the document
    // unavailable until something reads it again. An edit the person asked for reads it again itself rather than being
    // refused for that past failure: it writes if the read succeeds, and says the read's own reason if it fails (#2436).
    if (this.#state.phase === "unavailable") await this.refresh();
    const state = this.#state;
    if (left === 0) {
      throw new DocWriteError(
        "conflict",
        "",
        "The layout kept changing on another device, so this change was not saved",
      );
    }
    if (state.phase !== "ready") {
      const detail = unwritable(state);
      throw new DocWriteError("unwritable", detail, `The layout cannot take changes now: ${detail}`);
    }
    const next = change(state.doc);
    if (next === null) return false;
    this.#reads += 1;
    if (shown === "at once") this.#publish({ phase: "ready", doc: next, version: state.version });
    try {
      const { version } = await this.#calls.set(this.#on, next, state.version);
      this.#publish({ phase: "ready", doc: next, version });
      return true;
    } catch (cause) {
      // Any other failure is why the edit was not saved. The re-read still replaces the unsaved edit on screen, but when
      // the link closed under the write it is refused too, and that refusal must not stand in for the cause (#698).
      if (!isConflict(cause)) {
        await this.refresh();
        throw cause;
      }
      const { value, version } = await this.#calls.get(this.#on);
      this.#show(value, version);
    }
    return this.#attempt(change, shown, left - 1);
  }
}
