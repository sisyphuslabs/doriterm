import {
  type CursorPosition,
  type DisplayMode,
  type PredictionEvent,
  type PredictionScreen,
  Predictor,
  type ScreenCell,
} from "../prediction.ts";

/**
 * A terminal model the test writes by hand: cells, a cursor, a size, the alternate screen. It wraps as a terminal does:
 * a glyph written into the last column leaves the cursor there with a wrap pending, the next glyph goes to the start
 * of the next row, and on the last row that scrolls the screen up.
 */
export class FakeScreen implements PredictionScreen {
  #cells = new Map<string, ScreenCell>();
  /** The column after the last glyph written; `width` while a wrap is pending. */
  #position: CursorPosition = { row: 0, col: 0 };
  width = 80;
  height = 24;
  alt = false;

  get at(): CursorPosition {
    return { row: this.#position.row, col: Math.min(this.#position.col, this.width - 1) };
  }

  set at(position: CursorPosition) {
    this.#position = position;
  }

  cursor(): CursorPosition {
    return this.at;
  }

  cell(row: number, col: number): ScreenCell {
    return this.#cells.get(`${row}:${col}`) ?? { char: 0 };
  }

  cols(): number {
    return this.width;
  }

  rows(): number {
    return this.height;
  }

  altScreen(): boolean {
    return this.alt;
  }

  /** As a host's echo lands: each code point at the cursor, a wide one over two cells, wrapping past the last column. */
  echo(text: string): void {
    for (const each of text) {
      const width = widthOf(each) ?? 1;
      let { row, col } = this.#position;
      if (col + width > this.width) {
        row += 1;
        col = 0;
      }
      if (row === this.height) {
        this.#scroll();
        row -= 1;
      }
      this.#cells.set(`${row}:${col}`, { char: each.codePointAt(0) ?? 0, width });
      if (width === 2) this.#cells.set(`${row}:${col + 1}`, { char: 0, width: 0 });
      this.#position = { row, col: col + width };
    }
  }

  #scroll(): void {
    const moved = new Map<string, ScreenCell>();
    for (const [key, cell] of this.#cells) {
      const [row, col] = key.split(":").map(Number);
      if (row !== undefined && col !== undefined && row > 0) moved.set(`${row - 1}:${col}`, cell);
    }
    this.#cells = moved;
  }
}

/** Hangul syllables are two cells, `?` is a code point the width table has not answered yet, the rest one cell. */
export function widthOf(codepoint: string): number | undefined {
  const value = codepoint.codePointAt(0) ?? 0;
  if (codepoint === "?") return undefined;
  return value >= 0xac00 && value <= 0xd7a3 ? 2 : 1;
}

export interface Harness {
  readonly screen: FakeScreen;
  readonly predictor: Predictor;
  readonly events: PredictionEvent[];
  readonly clock: { now: number };
  /** `mode` is `always` unless a test is about the display gate, so the rules and epochs are tested on their own. */
  readonly link: { ready: boolean; composing: boolean; mode: DisplayMode };
  /** The host echoes `text` and the view tells the predictor it wrote. */
  readonly hostEchoes: (text: string) => void;
}

export function harness(options: { readonly observe?: boolean } = {}): Harness {
  const screen = new FakeScreen();
  const clock = { now: 1000 };
  const link: Harness["link"] = { ready: true, composing: false, mode: "always" };
  const events: PredictionEvent[] = [];
  const predictor = new Predictor({
    screen,
    widthOf,
    linkReady: () => link.ready,
    composing: () => link.composing,
    now: () => clock.now,
    mode: () => link.mode,
    observe: options.observe === true,
    onEvent: (event) => events.push(event),
  });
  const hostEchoes = (text: string): void => {
    screen.echo(text);
    predictor.wrote();
  };
  return { screen, predictor, events, clock, link, hostEchoes };
}

/** Puts the predictor in a confirmed epoch: one key typed and echoed. */
export function confirmed(h: Harness, key = "l"): void {
  h.predictor.typed(key, "key");
  h.hostEchoes(key);
}

/** The kinds of the events after the confirmations, e.g. `["reset:expired"]`. */
export const judgements = (h: Harness): string[] =>
  h.events.flatMap((event) => (event.kind === "confirmed" ? [] : [`${event.kind}:${event.cause}`]));
