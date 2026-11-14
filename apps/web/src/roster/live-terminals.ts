import type { Terminal } from "@doriface/protocol";
import { NO_TERMINALS, type TerminalsState } from "./terminals-state.ts";

/** Keeps the roster's feed open while a reader is here; returns the release. */
export type Keep = () => () => void;

/**
 * Every terminal as it stands now, title and foreground included, with readers of one terminal told only when that
 * terminal's entry changed (#2607). The roster's snapshot keeps the terminals as of their last change of shape; what a
 * terminal shows is read here.
 */
export class LiveTerminals {
  readonly #keep: Keep;
  readonly #readers = new Map<string, Set<() => void>>();
  readonly #listeners = new Set<() => void>();
  #state: TerminalsState = NO_TERMINALS;
  #byAddress: ReadonlyMap<string, Terminal> = new Map();

  constructor(keep: Keep) {
    this.#keep = keep;
  }

  get state(): TerminalsState {
    return this.#state;
  }

  get(address: string): Terminal | undefined {
    return this.#byAddress.get(address);
  }

  /** Told on every change of any terminal. */
  subscribe = (listener: () => void): (() => void) => this.#add(this.#listeners, listener);

  /** Told only when the terminal at `address` changes. */
  subscribeTo(address: string, listener: () => void): () => void {
    let set = this.#readers.get(address);
    if (set === undefined) {
      set = new Set();
      this.#readers.set(address, set);
    }
    const readers = set;
    const release = this.#add(readers, listener);
    return () => {
      release();
      if (readers.size === 0) this.#readers.delete(address);
    };
  }

  #add(set: Set<() => void>, listener: () => void): () => void {
    set.add(listener);
    const release = this.#keep();
    return () => {
      set.delete(listener);
      release();
    };
  }

  publish(state: TerminalsState): void {
    const before = this.#byAddress;
    this.#state = state;
    this.#byAddress = new Map(state.terminals.map((terminal) => [terminal.address, terminal]));
    for (const [address, readers] of this.#readers) {
      if (before.get(address) === this.#byAddress.get(address)) continue;
      for (const reader of readers) reader();
    }
    for (const listener of this.#listeners) listener();
  }
}
