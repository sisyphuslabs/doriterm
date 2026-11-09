import { DisplayGate, type DisplayMode, sendInterval } from "./prediction-display.ts";
import { type PredictionSource, readInput, type SuppressionRule, suppressedBy } from "./prediction-rules.ts";
import { type EchoRoundTrip, EchoRtt, expiryMs } from "./prediction-timing.ts";

export type { DisplayMode } from "./prediction-display.ts";
export type { PredictionSource, SuppressionRule } from "./prediction-rules.ts";
export type { EchoRoundTrip } from "./prediction-timing.ts";

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
  rows(): number;
  altScreen(): boolean;
}

/**
 * What the predictor did, for a log (S6's `__dorifacePredictLog`). `reset` is the one a person sees: drawn cells
 * vanished because they were judged wrong. `killEpoch` drops only predictions that were never drawn.
 */
export type PredictionEvent =
  | { readonly kind: "confirmed"; readonly latencyMs: number }
  | { readonly kind: "reset" | "killEpoch"; readonly cause: "incorrect" | "expired" | "alt-screen" | "row-left" };

export interface PredictorSources {
  readonly screen: PredictionScreen;
  /** Cells one code point takes by the terminal's width table, synchronously; undefined while not yet known (P7). */
  readonly widthOf: (codepoint: string) => number | undefined;
  /** An open stream whose link is proven, with nothing queued for it (P6). */
  readonly linkReady: () => boolean;
  /** An input method is composing (P5). */
  readonly composing: () => boolean;
  readonly now: () => number;
  /** mosh's display preference; `adaptive` when absent. */
  readonly mode?: () => DisplayMode;
  /** The stream only watches (P12). */
  readonly observe?: boolean;
  readonly onEvent?: (event: PredictionEvent) => void;
}

/** What a consumer (the overlay) gets of a prediction: where to draw which glyph over how many cells. */
export interface PredictedCell {
  readonly row: number;
  readonly col: number;
  readonly text: string;
  readonly width: 1 | 2;
}

interface Prediction extends PredictedCell {
  readonly epoch: number;
  /** Order of the keys as sent; the program answers them in this order, which is what a causal ack rests on. */
  readonly seq: number;
  readonly sentAt: number;
  /**
   * Whether the echo of this cell proves the program echoes: not for a blank, nor where the cell already showed the
   * same text before the key (mosh `CorrectNoCredit`, terminaloverlay.cc:91-109), since either matches with no echo.
   */
  readonly credit: boolean;
  /** On the row the predictor's own wrap moved the predicted cursor to, ahead of the host's cursor. */
  readonly wrapped: boolean;
}

export type Verdict =
  | { readonly kind: "predicted"; readonly cell: PredictedCell }
  | { readonly kind: "popped"; readonly rule: "P8"; readonly cell: PredictedCell }
  | { readonly kind: "refused"; readonly rule: SuppressionRule };

const cellText = (cell: ScreenCell): string => cell.chars ?? (cell.char === 0 ? " " : String.fromCodePoint(cell.char));

const shows = (cell: ScreenCell, text: string, width: number): boolean =>
  cellText(cell) === text && (cell.width ?? 1) === width;

const published = ({ row, col, text, width }: PredictedCell): PredictedCell => ({ row, col, text, width });

/**
 * mosh's predictive local echo (design note D1-D4) as a pure model over a read-only screen. Predictions never enter
 * the terminal model; they are cells for an overlay to draw, and only once their epoch is confirmed (one of its keys
 * echoed). A key the predictor refuses but the program receives starts a new epoch (P9). A prediction is judged
 * the way mosh judges it against `late_ack` (terminaloverlay.cc:86-111), with the one substitute the protocol allows:
 * the cell showing its text confirms it; it is wrong only when a key sent after it has been confirmed (the program
 * answers keys in order, so it has answered this one) and the cell still does not show it; and otherwise only expiry
 * ends it. Time alone never marks a prediction wrong: a late echo means "not yet known", as in mosh (design note D2).
 */
export class Predictor {
  readonly #sources: PredictorSources;
  readonly #rtt = new EchoRtt();
  readonly #gate = new DisplayGate();
  #predictions: readonly Prediction[] = [];
  #epoch = 1;
  #confirmedEpoch = 0;
  #seq = 0;
  /** The latest key, by `seq`, whose echo has confirmed it: every earlier key has been answered. */
  #answeredSeq = -1;
  /** Where the next prediction goes while predictions are outstanding; null means the real cursor. */
  #cursor: CursorPosition | null = null;
  #altScreen = false;
  #scrolledAway = false;
  #shown: { readonly from: readonly Prediction[]; readonly key: string; readonly cells: readonly PredictedCell[] } = {
    from: [],
    key: "",
    cells: [],
  };

  constructor(sources: PredictorSources) {
    this.#sources = sources;
  }

  /**
   * One input on its way to the program: sent now, or queued and sent in order later. Never changes what is sent; only
   * decides what is drawn meanwhile. Input that will never reach the program must not be passed here.
   */
  typed(input: string | Uint8Array, source: PredictionSource): Verdict {
    const { screen } = this.#sources;
    const shape = readInput(input);
    const at = this.#cursor ?? screen.cursor();
    const last = this.#predictions.at(-1);
    const width = shape.kind === "grapheme" && shape.codepoints === 1 ? this.#sources.widthOf(shape.text) : undefined;
    const row = suppressedBy({
      source,
      observe: this.#sources.observe === true,
      linkReady: this.#sources.linkReady(),
      composing: this.#sources.composing(),
      altScreen: screen.altScreen(),
      input: shape,
      canPop: last !== undefined && last.row === at.row && last.col + last.width === at.col,
      width,
      col: at.col,
      cols: screen.cols(),
    });
    if (row !== null) {
      // P9: a refused key that reaches the program starts a new epoch, as mosh does on CR and on any key it does not
      // model (become_tentative, terminaloverlay.cc:798-824). Where its effect leaves the cursor is unknown, so the
      // keys after it are predicted silently until one of THEM is echoed; predictions made before it stay, and are
      // confirmed by their own echoes. Enter is the case that matters most: a drawn prediction can stay up to its
      // expiry, and the one input where any such window is unacceptable is a password, since the line just submitted
      // may be the command that turns echo off and asks for one. Losing the drawn prediction on type-Enter-type is the
      // price, a missing nicety against a credential character on screen. This deliberately departs from the first
      // draft of docs/design/remote-input-feel.md D3, which showed that key and called it mosh's residual; it is not
      // mosh's. If code and note disagree again, correct the note rather than let them silently diverge.
      if (row.tentative) this.#epoch += 1;
      return { kind: "refused", rule: row.rule };
    }
    if (shape.kind === "grapheme") {
      return { kind: "predicted", cell: published(this.#predict(shape.text, width === 2 ? 2 : 1, at)) };
    }
    // P1 refuses both before this line; reaching it means the table no longer does.
    if (shape.kind === "other" || last === undefined) {
      throw new Error("the prediction table let through input P1 refuses");
    }
    this.#predictions = this.#predictions.slice(0, -1);
    this.#cursor = { row: last.row, col: last.col };
    return { kind: "popped", rule: "P8", cell: published(last) };
  }

  /** After each write into the terminal model: confirm what the host echoed, judge what it has answered otherwise. */
  wrote(): void {
    const { screen } = this.#sources;
    const altScreen = screen.altScreen();
    const entered = altScreen && !this.#altScreen;
    this.#altScreen = altScreen;
    if (entered) this.#drop(0, "alt-screen");
    else this.#cull(this.#sources.now());
    // Undrawn predictions off the cursor row, above or below, were made from a cursor that Enter, a clear (Ctrl-L) or
    // another unmodelled key has since moved; dropping them hides nothing and lets the next key start from the real
    // cursor. The exception is the predictor's own wrap: predictions it carried onto the rows below wait for the host to get there.
    const row = screen.cursor().row;
    const stale = this.#predictions.find(
      (each) => each.epoch > this.#confirmedEpoch && each.row !== row && !(each.wrapped && each.row > row),
    );
    if (stale !== undefined) this.#drop(this.#confirmedEpoch + 1, "row-left");
    if (this.#predictions.length === 0) this.#cursor = null;
  }

  /** On a clock (a frame or a timer): expiry, the glitch trigger and the display triggers advance with time. */
  tick(now: number): void {
    this.#cull(now);
  }

  /** On attach, reattach and `FULL_RESET`: nothing predicted survives, and the next epoch starts unconfirmed. */
  reset(): void {
    this.#predictions = [];
    this.#epoch += 1;
    this.#cursor = null;
    this.#altScreen = this.#sources.screen.altScreen();
  }

  /** The view is scrolled away from the end (P11): predictions are kept and not drawn. */
  setScrolledAway(away: boolean): void {
    this.#scrolledAway = away;
  }

  /** The predictor's echo round trip, once one key has been echoed. */
  get roundTrip(): EchoRoundTrip | undefined {
    return this.#rtt.estimate;
  }

  /** Drawn cells are underlined (mosh `flagging`: a slow link, or a glitch). */
  get underlined(): boolean {
    return this.#gate.underlined;
  }

  /** The cells to draw: those of a confirmed epoch, while the display gate is open. The same array until that changes. */
  visible(): readonly PredictedCell[] {
    const open = !this.#scrolledAway && this.#gate.shows(this.#sources.mode?.() ?? "adaptive");
    const key = `${String(open)}:${String(this.#confirmedEpoch)}`;
    if (this.#shown.from === this.#predictions && this.#shown.key === key) return this.#shown.cells;
    const upTo = this.#confirmedEpoch;
    const cells = open ? this.#predictions.filter((each) => each.epoch <= upTo).map(published) : [];
    this.#shown = { from: this.#predictions, key, cells };
    return cells;
  }

  /** Where the predicted cursor is drawn: after the last drawn cell, else null (the real cursor shows). */
  visibleCursor(): CursorPosition | null {
    const last = this.visible().at(-1);
    return last === undefined ? null : { row: last.row, col: last.col + last.width };
  }

  #predict(text: string, width: 1 | 2, at: CursorPosition): Prediction {
    const { screen } = this.#sources;
    // The last column, as mosh predicts it (terminaloverlay.cc:752-756, 789-795): tentatively, since a program may draw
    // its own wrap mark there or the cursor may already be in the terminal's pending wrap; and the predicted cursor then
    // wraps to the start of the next row, tentatively again. On the last row the screen scrolls instead, which
    // predictions do not follow (mosh: "Don't try to predict scroll"), so the cursor stays on that row.
    const wraps = at.col + width === screen.cols();
    if (wraps) this.#epoch += 1;
    const before = screen.cell(at.row, at.col);
    const last = this.#predictions.at(-1);
    const wrapped =
      last !== undefined &&
      ((last.wrapped && last.row === at.row) ||
        (at.col === 0 && at.row === last.row + 1 && last.col + last.width === screen.cols()));
    const cell: Prediction = {
      row: at.row,
      col: at.col,
      text,
      width,
      epoch: this.#epoch,
      seq: (this.#seq += 1),
      sentAt: this.#sources.now(),
      credit: text.trim() !== "" && !shows(before, text, width),
      wrapped,
    };
    this.#predictions = [...this.#predictions, cell];
    this.#cursor = { row: at.row, col: at.col + width };
    if (wraps) {
      this.#epoch += 1;
      this.#cursor = { row: Math.min(at.row + 1, screen.rows() - 1), col: 0 };
    }
    return cell;
  }

  /** mosh's `cull`: confirm what the screen shows, judge what has been answered or has expired, update the triggers. */
  #cull(now: number): void {
    const { screen } = this.#sources;
    const drawnUpTo = this.#confirmedEpoch;
    const unconfirmed: { readonly each: Prediction; readonly matches: boolean }[] = [];
    for (const each of this.#predictions) {
      const matches = shows(screen.cell(each.row, each.col), each.text, each.width);
      if (matches && each.credit) this.#confirm(each, now);
      else unconfirmed.push({ each, matches });
    }
    const expiry = expiryMs(this.#rtt.estimate);
    const settled = (each: Prediction): boolean => each.seq < this.#answeredSeq || now - each.sentAt >= expiry;
    // A match that proves no echo stays pending, holding the predicted cursor, until it is answered or expires; then
    // it goes without a judgement (mosh: CorrectNoCredit is only reached once acked, terminaloverlay.cc:88-97).
    const waiting = unconfirmed.filter(({ each, matches }) => !(matches && settled(each))).map(({ each }) => each);
    const judged = unconfirmed.find(({ each, matches }) => !matches && settled(each))?.each;
    if (judged !== undefined) {
      this.#predictions = waiting;
      this.#drop(judged.epoch, judged.seq < this.#answeredSeq ? "incorrect" : "expired", drawnUpTo);
    } else {
      for (const each of waiting) this.#gate.pending(now - each.sentAt);
      if (waiting.length !== this.#predictions.length) this.#predictions = waiting;
    }
    this.#gate.update(sendInterval(this.#rtt.estimate?.srtt), this.#predictions.length > 0);
  }

  #confirm(prediction: Prediction, now: number): void {
    const latency = now - prediction.sentAt;
    this.#confirmedEpoch = Math.max(this.#confirmedEpoch, prediction.epoch);
    this.#answeredSeq = Math.max(this.#answeredSeq, prediction.seq);
    this.#rtt.sample(latency);
    this.#gate.confirmed(latency, now);
    this.#sources.onEvent?.({ kind: "confirmed", latencyMs: latency });
  }

  /**
   * Drops the predictions of `fromEpoch` and later and becomes tentative: mosh's `kill_epoch` for an undrawn epoch.
   * When a drawn prediction goes with them, everything goes, as mosh's `reset()` does for a confirmed cell. Drawn means
   * drawn before this judgement: an epoch the same write confirmed had nothing on screen yet.
   */
  #drop(
    fromEpoch: number,
    cause: "incorrect" | "expired" | "alt-screen" | "row-left",
    drawnUpTo = this.#confirmedEpoch,
  ): void {
    const drawn = this.#predictions.some((each) => each.epoch <= drawnUpTo && each.epoch >= fromEpoch);
    this.#predictions = drawn ? [] : this.#predictions.filter((each) => each.epoch < fromEpoch);
    this.#epoch += 1;
    this.#cursor = null;
    this.#sources.onEvent?.({ kind: drawn ? "reset" : "killEpoch", cause });
  }
}
