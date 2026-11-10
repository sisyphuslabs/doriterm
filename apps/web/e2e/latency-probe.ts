import type { Locator } from "@playwright/test";

/** Where the grid's cursor is: its row among the screen rows, its column, and the row's text before it. */
export interface Cursor {
  readonly row: number;
  readonly col: number;
  readonly before: string;
}

/** One key as the page saw it: the grapheme it typed and its event's timestamp, on the `performance.now()` clock. */
export interface Keystroke {
  readonly grapheme: string;
  readonly t0: number;
}

/**
 * One frame as painted on the measured row, from the typed line's first column: the grid's own cells and cursor, and
 * the same with the prediction layer's cells and cursor merged in (`union`). A wide cell's second column is "".
 */
export interface LatencyFrame {
  readonly t: number;
  readonly grid: readonly string[];
  readonly gridCursor: number | null;
  readonly union: readonly string[];
  readonly unionCursor: number | null;
}

export interface ProbeRecord {
  readonly keys: readonly Keystroke[];
  readonly frames: readonly LatencyFrame[];
}

/** One typed grapheme: how long until any layer showed it (to-glyph) and until the grid showed the echo (to-echo). */
export interface LatencySample {
  readonly grapheme: string;
  readonly toGlyphMs: number;
  readonly toEchoMs: number;
}

/** A Hangul syllable takes two cells; every other character this harness types takes one. */
const cellsOf = (grapheme: string): number => (/^[\uac00-\ud7a3]$/u.test(grapheme) ? 2 : 1);

export const graphemesOf = (text: string): string[] =>
  [...new Intl.Segmenter().segment(text)].map((part) => part.segment);

/** How many cells `text` takes on the grid. */
export const widthOf = (text: string): number =>
  graphemesOf(text).reduce((cells, grapheme) => cells + cellsOf(grapheme), 0);

/** What the page reads the screen with, installed once per page by `install`. */
interface Cells {
  screenRows(root: Element): HTMLElement[];
  cellWidth(root: Element): number;
  /** A row's cells by where each glyph is laid out, so a wide glyph is one cell at its column whatever its text. */
  rowCells(row: HTMLElement, cell: number): (string | undefined)[];
  /** The column of wterm's `.term-cursor` when this row holds it. */
  gridCursorCol(row: HTMLElement, cell: number): number | null;
}

async function install(terminal: Locator): Promise<void> {
  await terminal.evaluate(() => {
    if (Reflect.has(window, "__latencyCells")) return;
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- evaluate sends this function as source, so its helpers live inside it
    const columnAt = (left: number, rowBox: DOMRect, cell: number): number => Math.round((left - rowBox.left) / cell);
    const cells: Cells = {
      screenRows: (root) => [...root.querySelectorAll<HTMLElement>(".term-grid .term-row:not(.term-scrollback-row)")],
      cellWidth: (root) => Number.parseFloat(getComputedStyle(root).getPropertyValue("--term-cell-width")),
      rowCells(row, cell) {
        const box = row.getBoundingClientRect();
        const found: (string | undefined)[] = [];
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          if (!(node instanceof Text)) continue;
          const wide = node.parentElement?.closest(".term-wide");
          if (wide !== null && wide !== undefined) {
            found[columnAt(wide.getBoundingClientRect().left, box, cell)] = node.data;
            continue;
          }
          let offset = 0;
          for (const char of node.data) {
            const range = document.createRange();
            range.setStart(node, offset);
            range.setEnd(node, offset + char.length);
            found[columnAt(range.getBoundingClientRect().left, box, cell)] = char;
            offset += char.length;
          }
        }
        return found;
      },
      gridCursorCol(row, cell) {
        const cursor = row.querySelector(".term-cursor");
        return cursor === null
          ? null
          : columnAt(cursor.getBoundingClientRect().left, row.getBoundingClientRect(), cell);
      },
    };
    Reflect.set(window, "__latencyCells", cells);
  });
}

/** The grid's cursor now. */
export async function cursorOf(terminal: Locator): Promise<Cursor> {
  await install(terminal);
  return terminal.evaluate((root) => {
    const page = Reflect.get(window, "__latencyCells") as Cells;
    const cell = page.cellWidth(root);
    const rows = page.screenRows(root);
    const row = rows.findIndex((each) => page.gridCursorCol(each, cell) !== null);
    const at = rows[row];
    if (at === undefined) return { row: -1, col: -1, before: "" };
    const col = page.gridCursorCol(at, cell) ?? -1;
    const cells = page.rowCells(at, cell);
    const before = Array.from({ length: col }, (_, index) => cells[index] ?? " ").join("");
    return { row, col, before: before.replace(/^\s+/, "") };
  });
}

/**
 * Starts recording on the terminal: every key of `source` (a printable ASCII `keydown`, or an `input` of type
 * `insertText` as CDP's Input.insertText and an IME commit send) in the capture phase, before the terminal handles it,
 * and every frame's cells on `start`'s row from its column. A frame is sampled in a ResizeObserver callback, which runs
 * after every animation-frame callback of the frame (the pacer's write, the renderer, the overlay) and before the
 * paint, so a sample is the frame as painted (as prediction-frames.ts samples).
 */
export async function startProbe(terminal: Locator, start: Cursor, source: "keydown" | "insertText"): Promise<void> {
  await install(terminal);
  await terminal.evaluate(
    (root, { row, col, kind }) => {
      const page = Reflect.get(window, "__latencyCells") as Cells;
      const keys: Keystroke[] = [];
      const frames: LatencyFrame[] = [];
      let on = true;
      const onKey = (event: Event): void => {
        if (on && kind === "keydown" && event instanceof KeyboardEvent && /^[ -~]$/.test(event.key))
          keys.push({ grapheme: event.key, t0: event.timeStamp });
      };
      const onInput = (event: Event): void => {
        if (!on || kind !== "insertText" || !(event instanceof InputEvent)) return;
        if (event.inputType === "insertText" && event.data !== null)
          keys.push({ grapheme: event.data, t0: event.timeStamp });
      };
      root.addEventListener("keydown", onKey, true);
      root.addEventListener("input", onInput, true);
      const fromStart = (cells: readonly (string | undefined)[]): string[] =>
        Array.from(cells.slice(col), (each) => each ?? "");
      const sample = (): void => {
        const cell = page.cellWidth(root);
        const at = page.screenRows(root)[row];
        if (at === undefined) return;
        const box = at.getBoundingClientRect();
        const grid = page.rowCells(at, cell);
        const gridCursor = page.gridCursorCol(at, cell);
        const union = [...grid];
        const columnOnRow = (element: Element): number | null => {
          const placed = element.getBoundingClientRect();
          if (Math.round((placed.top - box.top) / box.height) !== 0) return null;
          return Math.round((placed.left - box.left) / cell);
        };
        for (const predicted of root.querySelectorAll(".term-prediction-cell")) {
          const column = columnOnRow(predicted);
          if (column !== null) union[column] = predicted.textContent ?? "";
        }
        let unionCursor = gridCursor;
        for (const predicted of root.querySelectorAll(".term-prediction-cursor"))
          unionCursor = columnOnRow(predicted) ?? unionCursor;
        frames.push({
          t: performance.now(),
          grid: fromStart(grid),
          gridCursor: gridCursor === null ? null : gridCursor - col,
          union: fromStart(union),
          unionCursor: unionCursor === null ? null : unionCursor - col,
        });
      };
      const probe = document.createElement("div");
      probe.style.cssText = "position:fixed;left:-10px;top:-10px;height:1px;pointer-events:none";
      document.body.appendChild(probe);
      new ResizeObserver(() => {
        if (on) sample();
      }).observe(probe);
      let frame = 0;
      const tick = (): void => {
        frame += 1;
        probe.style.width = `${1 + (frame % 2)}px`;
        if (on) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      Reflect.set(window, "__latencyProbe", (): ProbeRecord => {
        on = false;
        probe.remove();
        root.removeEventListener("keydown", onKey, true);
        root.removeEventListener("input", onInput, true);
        return { keys, frames };
      });
    },
    { row: start.row, col: start.col, kind: source },
  );
}

/** Stops the probe and returns every key and frame it recorded, in order. */
export const stopProbe = (terminal: Locator): Promise<ProbeRecord> =>
  terminal.evaluate(() => (Reflect.get(window, "__latencyProbe") as () => ProbeRecord)());

/** Whether a frame's cells and cursor show `graphemes` through index `last`, laid out from the first column. */
function shows(cells: readonly string[], cursor: number | null, graphemes: readonly string[], last: number): boolean {
  let column = 0;
  for (const grapheme of graphemes.slice(0, last + 1)) {
    const shown = cells[column] ?? "";
    if (grapheme === " " ? shown.trim() !== "" : shown !== grapheme) return false;
    column += cellsOf(grapheme);
  }
  return cursor !== null && cursor >= column;
}

/**
 * Per typed grapheme: the first frame that shows it and everything before it, with any layer (to-glyph) and on the
 * grid alone (to-echo), less the key's own timestamp. Throws when the keys recorded are not the line typed, or a
 * grapheme was never shown: a measurement that missed a key is not a number.
 */
export function latencies(record: ProbeRecord, graphemes: readonly string[]): LatencySample[] {
  const typed = record.keys.map((key) => key.grapheme).join("");
  if (typed !== graphemes.join(""))
    throw new Error(`the probe recorded ${JSON.stringify(typed)}, not ${JSON.stringify(graphemes.join(""))}`);
  return record.keys.map((key, index) => {
    const first = (layer: "grid" | "union"): number => {
      const frame = record.frames.find((each) =>
        shows(each[layer], layer === "grid" ? each.gridCursor : each.unionCursor, graphemes, index),
      );
      if (frame === undefined)
        throw new Error(`no frame showed ${JSON.stringify(key.grapheme)} (key ${index}) on the ${layer}`);
      return frame.t - key.t0;
    };
    return { grapheme: key.grapheme, toGlyphMs: first("union"), toEchoMs: first("grid") };
  });
}

/** The nearest-rank percentile: the value at rank ⌈p/100 · n⌉ of the sorted values (docs/architecture.md §5). */
const percentile = (sorted: readonly number[], p: number): number => {
  const value = sorted[Math.ceil((p / 100) * sorted.length) - 1];
  if (value === undefined) throw new Error("no samples");
  return value;
};

/** Median and p95 of both latencies; refuses fewer than 100 samples, as the latency bench does. */
export function summarize(samples: readonly LatencySample[]): {
  readonly n: number;
  readonly median: { readonly toGlyphMs: number; readonly toEchoMs: number };
  readonly p95: { readonly toGlyphMs: number; readonly toEchoMs: number };
} {
  if (samples.length < 100) throw new Error(`${samples.length} samples: at least 100 are needed for a percentile`);
  const glyph = samples.map((sample) => sample.toGlyphMs).toSorted((a, b) => a - b);
  const echo = samples.map((sample) => sample.toEchoMs).toSorted((a, b) => a - b);
  return {
    n: samples.length,
    median: { toGlyphMs: percentile(glyph, 50), toEchoMs: percentile(echo, 50) },
    p95: { toGlyphMs: percentile(glyph, 95), toEchoMs: percentile(echo, 95) },
  };
}
