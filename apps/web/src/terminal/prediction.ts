import {
  decodeInput,
  type PredictionSource,
  readInput,
  submitsLine,
  type SuppressionRule,
  suppressedBy,
} from "./prediction-rules.ts";

export type { PredictionSource, SuppressionRule } from "./prediction-rules.ts";

/** A cell of the terminal model as wterm's core reports it (`CellData`): the code point, the grapheme, the width. */
export interface ScreenCell {
  readonly char: number;
  readonly chars?: string | undefined;
  readonly width?: number | undefined;
}

export interface CursorPosition {
  readonly row: number;
  readonly col: number;
}

/** What the predictor reads from the terminal model; S6 adapts `wt.bridge` to it. It only ever reads. */
export interface PredictionScreen {
  cursor(): CursorPosition;
  cell(row: number, col: number): ScreenCell;
  cols(): number;
  altScreen(): boolean;
}

/** The part of the connection's round-trip estimate (`HcConnection.rtt`, S0) the predictor reads, in ms. */
export interface RttReading {
  readonly srtt: number;
}

export interface PredictorSources {
  readonly screen: PredictionScreen;
  /** Cells one code point takes by the terminal's width table, synchronously; undefined while not yet known (P7). */
  readonly widthOf: (codepoint: string) => number | undefined;
  /** An open stream whose link is proven, with nothing queued for it (P6). */
  readonly linkReady: () => boolean;
  /** An input method is composing (P5). */
  readonly composing: () => boolean;
  readonly rtt: () => RttReading | undefined;
  readonly now: () => number;
  /** The stream only watches (P12). */
  readonly observe?: boolean;
  /** Each confirming echo's latency, `now - sentAt` in ms, the measurement the timing constants are tuned on. */
  readonly onEcho?: (latencyMs: number) => void;
}

export interface PredictedCell {
  readonly row: number;
  readonly col: number;
  readonly text: string;
  readonly width: 1 | 2;
  readonly epoch: number;
  readonly sentAt: number;
}

interface Prediction extends PredictedCell {
  /**
   * Whether the echo of this cell proves the program echoes: not for a blank, nor where the cell already showed the
   * same text before the key (mosh `CorrectNoCredit`, terminaloverlay.cc:91-109), since either matches with no echo.
   */
  readonly credit: boolean;
}

export type Verdict =
  | { readonly kind: "predicted"; readonly cell: PredictedCell }
  | { readonly kind: "popped"; readonly rule: "P8"; readonly cell: PredictedCell }
  | { readonly kind: "refused"; readonly rule: SuppressionRule };

/**
 * How long a prediction may wait for its echo: `clamp(1.5 * srtt + 120, 200, 1500)` ms (design note D2). One and a half
 * round trips covers an echo the program sends at once plus the paint after it; the floor keeps a LAN link from killing
 * on scheduling jitter, the ceiling bounds the time a non-echoed character can stay drawn. Without an estimate the
 * ceiling is used: S0 makes every answered call a sample (attach included), so a stream that exists has one.
 */
export const DUE_SRTT_FACTOR = 1.5;
export const DUE_SLACK_MS = 120;
export const DUE_MIN_MS = 200;
export const DUE_MAX_MS = 1500;

export function predictionDue(rtt: RttReading | undefined): number {
  if (rtt === undefined) return DUE_MAX_MS;
  return Math.min(DUE_MAX_MS, Math.max(DUE_MIN_MS, DUE_SRTT_FACTOR * rtt.srtt + DUE_SLACK_MS));
}

const cellText = (cell: ScreenCell): string => cell.chars ?? (cell.char === 0 ? " " : String.fromCodePoint(cell.char));

const shows = (cell: ScreenCell, text: string, width: number): boolean =>
  cellText(cell) === text && (cell.width ?? 1) === width;

/**
 * mosh's predictive local echo (design note D1-D4) as a pure model over a read-only screen. Predictions never enter
 * the terminal model; they are cells for an overlay to draw. Each carries the epoch it was made in, and the cells are
 * shown only while that epoch is confirmed, i.e. one of its predictions was echoed by the host. A kill (a mismatch past
 * `due`, no echo by `due`, the cursor leaving the row, the alternate screen, a reset) drops every prediction and starts
 * a new, unconfirmed epoch, so what is typed next is predicted silently until the host echoes one of it; a submitted
 * line starts a new epoch too, keeping what was predicted before it. There is no
 * input acknowledgement in the protocol, so `due` is the only bound on how long an unechoed character is drawn.
 */
export class Predictor {
  readonly #sources: PredictorSources;
  #predictions: readonly Prediction[] = [];
  #epoch = 1;
  #confirmedEpoch = 0;
  /** Where the next prediction goes while predictions are outstanding; null means the real cursor. */
  #cursor: CursorPosition | null = null;
  #frozen = false;
  #altScreen = false;
  #scrolledAway = false;
  #shown: { readonly from: readonly Prediction[]; readonly upTo: number; readonly cells: readonly Prediction[] } = {
    from: [],
    upTo: 0,
    cells: [],
  };

  constructor(sources: PredictorSources) {
    this.#sources = sources;
  }

  /** One input on its way to the program. Never changes what is sent; only decides what is drawn meanwhile. */
  typed(input: string | Uint8Array, source: PredictionSource): Verdict {
    const { screen } = this.#sources;
    const text = decodeInput(input);
    // A submitted line starts a new epoch, as mosh does on CR (become_tentative, terminaloverlay.cc:798-799), so the
    // first key typed after Enter is never drawn before its echo. A prediction is drawn for up to `due` (~495 ms at
    // srtt 250), and the one input where that window is unacceptable is a password: the line just submitted may be the
    // command that turns echo off and asks for one. Losing the drawn prediction on type-Enter-type is the price, a
    // missing nicety against a credential character on screen. This deliberately departs from the first draft of
    // docs/design/remote-input-feel.md D3, which showed that key for up to `due` and called it mosh's residual; it is
    // not mosh's. If code and note disagree again, correct the note rather than let them silently diverge.
    if (submitsLine(text)) this.#epoch += 1;
    const shape = readInput(text);
    const at = this.#cursor ?? screen.cursor();
    const last = this.#predictions.at(-1);
    const width = shape.kind === "grapheme" && shape.codepoints === 1 ? this.#sources.widthOf(shape.text) : undefined;
    const row = suppressedBy({
      source,
      observe: this.#sources.observe === true,
      linkReady: this.#sources.linkReady(),
      composing: this.#sources.composing(),
      altScreen: screen.altScreen(),
      frozen: this.#frozen,
      input: shape,
      canPop: last !== undefined && last.row === at.row && last.col + last.width === at.col,
      width,
      col: at.col,
      cols: screen.cols(),
    });
    if (row !== null) {
      if (row.freezes) this.#frozen = true;
      return { kind: "refused", rule: row.rule };
    }
    if (shape.kind === "grapheme")
      return { kind: "predicted", cell: this.#predict(shape.text, width === 2 ? 2 : 1, at) };
    // P1 refuses both before this line; reaching it means the table no longer does.
    if (shape.kind === "other" || last === undefined)
      throw new Error("the prediction table let through input P1 refuses");
    this.#predictions = this.#predictions.slice(0, -1);
    this.#cursor = { row: last.row, col: last.col };
    return { kind: "popped", rule: "P8", cell: last };
  }

  /** After each write into the terminal model: confirm what the host echoed, kill what it contradicted. */
  wrote(): void {
    const { screen } = this.#sources;
    const altScreen = screen.altScreen();
    const entered = altScreen && !this.#altScreen;
    this.#altScreen = altScreen;
    if (entered) this.#kill();
    else this.#validate(this.#sources.now());
    const anchor = this.#predictions[0];
    if (anchor !== undefined && screen.cursor().row !== anchor.row) this.#kill();
    if (this.#predictions.length === 0) {
      this.#cursor = null;
      this.#frozen = false;
    }
  }

  /** On a clock (a frame or a timer): the echo that never came kills its epoch once `due` has passed. */
  tick(now: number): void {
    if (this.#predictions.length > 0) this.#validate(now);
  }

  /** On attach, reattach and `FULL_RESET`: nothing predicted survives, and the next epoch starts unconfirmed. */
  reset(): void {
    this.#kill();
    this.#frozen = false;
    this.#altScreen = this.#sources.screen.altScreen();
  }

  /** The view is scrolled away from the end (P11): predictions are kept and not drawn. */
  setScrolledAway(away: boolean): void {
    this.#scrolledAway = away;
  }

  /**
   * The cells to draw: those whose epoch is confirmed, so keys typed before an Enter stay drawn while the keys after it
   * wait for an echo. The same array until the predictions or the confirmed epoch change.
   */
  visible(): readonly PredictedCell[] {
    if (this.#scrolledAway) return [];
    const shown = this.#shown;
    if (shown.from === this.#predictions && shown.upTo === this.#confirmedEpoch) return shown.cells;
    const upTo = this.#confirmedEpoch;
    const cells = this.#predictions.filter((prediction) => prediction.epoch <= upTo);
    this.#shown = { from: this.#predictions, upTo, cells };
    return cells;
  }

  /** Where the predicted cursor is drawn: after the last drawn cell, else null (the real cursor shows). */
  visibleCursor(): CursorPosition | null {
    const last = this.visible().at(-1);
    return last === undefined ? null : { row: last.row, col: last.col + last.width };
  }

  #predict(text: string, width: 1 | 2, at: CursorPosition): PredictedCell {
    const before = this.#sources.screen.cell(at.row, at.col);
    const cell: Prediction = {
      row: at.row,
      col: at.col,
      text,
      width,
      epoch: this.#epoch,
      sentAt: this.#sources.now(),
      credit: text.trim() !== "" && !shows(before, text, width),
    };
    this.#predictions = [...this.#predictions, cell];
    this.#cursor = { row: at.row, col: at.col + width };
    return cell;
  }

  #validate(now: number): void {
    const due = predictionDue(this.#sources.rtt());
    const kept: Prediction[] = [];
    for (const prediction of this.#predictions) {
      const echoed = shows(
        this.#sources.screen.cell(prediction.row, prediction.col),
        prediction.text,
        prediction.width,
      );
      const late = now - prediction.sentAt >= due;
      if (echoed && prediction.credit) {
        this.#confirmedEpoch = Math.max(this.#confirmedEpoch, prediction.epoch);
        this.#sources.onEcho?.(now - prediction.sentAt);
      } else if (late && !echoed) {
        this.#kill();
        return;
      } else if (!late) {
        kept.push(prediction);
      }
    }
    if (kept.length !== this.#predictions.length) this.#predictions = kept;
  }

  #kill(): void {
    this.#predictions = [];
    this.#epoch += 1;
    this.#cursor = null;
  }
}
