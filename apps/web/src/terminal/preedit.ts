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

/**
 * Each codepoint's width as the terminal's own core gives it (Ghostty's width table, not a guess), from a one-row core
 * of its own. Known codepoints are answered without the core; `dispose` frees it.
 */
export class CodepointWidths {
  readonly #wide = new Map<number, boolean>();
  #core: Promise<GhosttyCore> | null = null;
  #disposed = false;
  readonly #load: () => Promise<GhosttyCore>;

  constructor(load: () => Promise<GhosttyCore> = () => loadGhosttyCore()) {
    this.#load = load;
  }

  async of(text: string): Promise<PreeditCodepoint[]> {
    const codepoints = [...text];
    const unknown = codepoints.filter((each) => !this.#wide.has(each.codePointAt(0) ?? 0));
    if (unknown.length > 0) {
      const core = await (this.#core ??= this.#load().then((made) => {
        made.init(4, 1);
        return made;
      }));
      for (const each of unknown) {
        // oxlint-disable-next-line no-await-in-loop -- one core, one cell: each codepoint is written and read in turn
        await write(core, `\u001B[H\u001B[2K${each}`);
        this.#wide.set(each.codePointAt(0) ?? 0, core.getCell(0, 0).width === 2);
      }
      if (this.#disposed) core.dispose();
    }
    return codepoints.map((each) => ({ text: each, wide: this.#wide.get(each.codePointAt(0) ?? 0) === true }));
  }

  dispose(): void {
    this.#disposed = true;
    void this.#core?.then((core) => core.dispose());
    this.#core = null;
  }
}
