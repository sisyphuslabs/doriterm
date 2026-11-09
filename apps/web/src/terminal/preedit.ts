import { loadGhosttyCore } from "@doriface/ghostty-wasm";
import type { GhosttyCore } from "@wterm/ghostty";

/** One codepoint of the text an input method is composing, as Ghostty keeps it (renderer/State.zig `Preedit`). */
export interface PreeditCodepoint {
  readonly text: string;
  /** Two cells wide, by the terminal's own width table. */
  readonly wide: boolean;
}

/** Where the preedit is drawn: its first and last cell, and how many leading codepoints did not fit. */
export interface PreeditRange {
  readonly start: number;
  readonly end: number;
  readonly offset: number;
}

/**
 * Ghostty's `Preedit.range`: the preedit starts at the cursor, and when it runs past the last column it shifts left, or
 * drops its first codepoints when it is wider than the row. `max` is the last column. Ghostty keeps the codepoint that
 * first overflows as well, against its own comment ("a point where our width would be less than the number of cells");
 * here it is dropped, and only a preedit wider than the whole row drops any, so the preedit never draws past the row.
 */
export function preeditRange(codepoints: readonly PreeditCodepoint[], start: number, max: number): PreeditRange {
  const maxWidth = max + 1;
  let width = 0;
  let offset = 0;
  for (let index = codepoints.length - 1; index >= 0; index -= 1) {
    const cells = codepoints[index]?.wide === true ? 2 : 1;
    if (width + cells > maxWidth) {
      offset = index + 1;
      break;
    }
    width += cells;
  }
  const end = width > 0 ? start + (width - 1) : start;
  const shift = end > max ? end - max : 0;
  return { start: Math.max(0, start - shift), end: Math.max(0, end - shift), offset };
}

const write = (core: GhosttyCore, text: string): Promise<void> =>
  new Promise((resolve) => {
    core.writeString(text, resolve);
  });

/** Runs `work` when the page is idle: `requestIdleCallback` where it exists, else the next task. */
const whenIdle = (work: () => Promise<void>): void => {
  if (typeof requestIdleCallback === "function") requestIdleCallback(() => void work());
  else setTimeout(() => void work(), 0);
};

/** Code points `warm` measures in one idle slice. */
const WARM_SLICE = 512;

/**
 * Each codepoint's width as the terminal's own core gives it (Ghostty's width table, not a guess), from a one-row core
 * of its own. Known codepoints are answered without the core; `known` answers them synchronously, and `warm` measures
 * ranges ahead of need in idle time. `dispose` frees the core.
 */
export class CodepointWidths {
  readonly #wide = new Map<number, boolean>();
  #core: Promise<GhosttyCore> | null = null;
  #disposed = false;
  /** One codepoint is written and read at a time: `of` and `warm` share the one cell. */
  #measuring: Promise<void> = Promise.resolve();
  readonly #load: () => Promise<GhosttyCore>;
  readonly #idle: (work: () => Promise<void>) => void;

  constructor(
    load: () => Promise<GhosttyCore> = () => loadGhosttyCore(),
    idle: (work: () => Promise<void>) => void = whenIdle,
  ) {
    this.#load = load;
    this.#idle = idle;
  }

  #measure(codepoint: number): Promise<void> {
    const core = (this.#core ??= this.#load().then((made) => {
      made.init(4, 1);
      return made;
    }));
    const measured = this.#measuring.then(() => this.#measureNow(codepoint, core));
    this.#measuring = measured.catch(() => undefined);
    return measured;
  }

  async #measureNow(codepoint: number, core: Promise<GhosttyCore>): Promise<void> {
    if (this.#wide.has(codepoint)) return;
    const ready = await core;
    await write(ready, `\u001B[H\u001B[2K${String.fromCodePoint(codepoint)}`);
    this.#wide.set(codepoint, ready.getCell(0, 0).width === 2);
  }

  async of(text: string): Promise<PreeditCodepoint[]> {
    const codepoints = [...text];
    const unknown = codepoints.filter((each) => !this.#wide.has(each.codePointAt(0) ?? 0));
    if (unknown.length > 0) {
      await Promise.all(unknown.map((each) => this.#measure(each.codePointAt(0) ?? 0)));
      // Disposed while measuring: free the core this call made or kept.
      if (this.#disposed) this.dispose();
    }
    return codepoints.map((each) => ({ text: each, wide: this.#wide.get(each.codePointAt(0) ?? 0) === true }));
  }

  /** The cached wide flag; undefined while the codepoint has not been measured. */
  known(codepoint: number): boolean | undefined {
    return this.#wide.get(codepoint);
  }

  /** Measures every codepoint of the inclusive `[first, last]` ranges in idle slices; the returned call stops it. */
  warm(ranges: readonly (readonly [number, number])[]): () => void {
    let cancelled = false;
    const next = (function* (): Generator<number> {
      for (const [first, last] of ranges)
        for (let codepoint = first; codepoint <= last; codepoint += 1) yield codepoint;
    })();
    const slice = async (): Promise<void> => {
      if (cancelled || this.#disposed) return;
      const batch: number[] = [];
      for (let step = next.next(); !step.done; step = next.next()) {
        if (!this.#wide.has(step.value)) batch.push(step.value);
        if (batch.length === WARM_SLICE) break;
      }
      if (batch.length === 0) return;
      await Promise.all(batch.map((codepoint) => this.#measure(codepoint)));
      if (!cancelled && !this.#disposed) this.#idle(slice);
    };
    this.#idle(slice);
    return () => {
      cancelled = true;
    };
  }

  dispose(): void {
    this.#disposed = true;
    void this.#core?.then((core) => core.dispose());
    this.#core = null;
  }
}
