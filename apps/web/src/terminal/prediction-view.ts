import type { WTerm } from "@wterm/react";
import type { OverlaySource } from "./prediction-cells.ts";
import type { DisplayMode } from "./prediction-display.ts";
import { type PredictedCell, type PredictionEvent, Predictor } from "./prediction.ts";
import type { TerminalInput } from "./terminal-view-props.ts";

/**
 * Cells a code point takes, synchronously, where Ghostty's width table and East Asian Width agree beyond doubt: printable
 * ASCII one, Hangul, kana, CJK ideographs and the full-width forms two. Anything else is unknown, so the predictor
 * refuses it (P7) rather than guess, and the echo draws it.
 */
export function knownWidth(codepoint: string): 1 | 2 | undefined {
  const code = codepoint.codePointAt(0) ?? 0;
  if (code >= 0x20 && code <= 0x7e) return 1;
  const wide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0x3130 && code <= 0x318f) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xff01 && code <= 0xff60);
  return wide ? 2 : undefined;
}

/** The last events, for a spec or a person debugging on a device: `window.__dorifacePredictLog`. */
const LOG_LIMIT = 1000;
function logged(event: PredictionEvent): void {
  let log: unknown = Reflect.get(globalThis, "__dorifacePredictLog");
  if (!Array.isArray(log)) {
    log = [];
    Reflect.set(globalThis, "__dorifacePredictLog", log);
  }
  const events = log as PredictionEvent[];
  events.push(event);
  if (events.length > LOG_LIMIT) events.splice(0, events.length - LOG_LIMIT);
}

export interface PredictorViewSources {
  /** The stream is open and proven, its machine is not away, and nothing typed earlier still waits (P6). */
  readonly linkReady: () => boolean;
  readonly mode: () => DisplayMode;
}

/**
 * The real predictor fed by one view (plan S6, #1595): every input on its way to the program goes to `typed`, every write
 * into the terminal model to `wrote`, and a frame clock to `tick` while keys are outstanding; the overlay reads it as its
 * source. Input the core sends while a write runs is the terminal answering a query (P10), never a key.
 *
 * Composition is read from the input element's own events in the capture phase, so a syllable wterm commits on
 * `compositionend` arrives here after composing ended: the commit is a key, not a composition (#1439 HIGH 3(a); gating on
 * the preedit's drawn state refuses every committed syllable, because the preedit is cleared after the commit).
 */
export class PredictorView implements OverlaySource {
  readonly #predictor: Predictor;
  readonly #element: HTMLElement;
  readonly #listeners = new Set<() => void>();
  readonly #undo: (() => void)[] = [];
  #composing = false;
  #writing = 0;
  #frame = 0;
  #tickUntil = 0;
  #shown: readonly PredictedCell[] = [];
  #flagging = false;

  constructor(wt: WTerm, sources: PredictorViewSources) {
    this.#element = wt.element;
    this.#predictor = new Predictor({
      screen: {
        cursor: () => {
          const cursor = wt.bridge?.getCursor();
          return { row: cursor?.row ?? 0, col: cursor?.col ?? 0 };
        },
        cell: (row, col) => wt.bridge?.getCell(row, col) ?? { char: 0 },
        cols: () => wt.bridge?.getCols() ?? 0,
        rows: () => wt.bridge?.getRows() ?? 0,
        altScreen: () => wt.bridge?.usingAltScreen() ?? false,
      },
      widthOf: knownWidth,
      linkReady: sources.linkReady,
      composing: () => this.#composing,
      now: () => performance.now(),
      mode: sources.mode,
      onEvent: logged,
    });
    const write = wt.write.bind(wt);
    wt.write = (data) => {
      this.#writing += 1;
      try {
        write(data);
      } finally {
        this.#writing -= 1;
      }
      this.#predictor.wrote();
      this.#changed();
    };
    this.#undo.push(() => {
      wt.write = write;
    });
    const started = (): void => {
      this.#composing = true;
    };
    const ended = (): void => {
      this.#composing = false;
    };
    const scrolled = (): void => {
      const element = this.#element;
      this.#predictor.setScrolledAway(element.scrollHeight - element.clientHeight - element.scrollTop > 1);
      this.#changed();
    };
    this.#element.addEventListener("compositionstart", started, true);
    this.#element.addEventListener("compositionend", ended, true);
    this.#element.addEventListener("scroll", scrolled, { passive: true });
    this.#undo.push(() => {
      this.#element.removeEventListener("compositionstart", started, true);
      this.#element.removeEventListener("compositionend", ended, true);
      this.#element.removeEventListener("scroll", scrolled);
    });
  }

  /** One input on its way to the program, before it is sent or queued. */
  typed(input: TerminalInput): void {
    this.#predictor.typed(input, this.#writing > 0 ? "automatic" : "key");
    this.#tickUntil = performance.now() + 11_000;
    this.#schedule();
    this.#changed();
  }

  /** A new stream (attach, reattach): nothing predicted for the last one survives. */
  reset(): void {
    this.#predictor.reset();
    this.#changed();
  }

  /** The display mode changed: what is shown may change with no input or write. */
  refresh(): void {
    this.#changed();
  }

  visible(): readonly PredictedCell[] {
    return this.#predictor.visible();
  }

  /** mosh's flagging: the link is slow or glitching, so drawn cells are underlined (#1439 HIGH 2). */
  underlined(): boolean {
    return this.#predictor.underlined;
  }

  subscribe(changed: () => void): () => void {
    this.#listeners.add(changed);
    return () => this.#listeners.delete(changed);
  }

  dispose(): void {
    cancelAnimationFrame(this.#frame);
    for (const undo of this.#undo.splice(0)) undo();
    this.#listeners.clear();
  }

  /** Expiry and the display triggers move with time, so frames tick while a key may still be outstanding. */
  #schedule(): void {
    if (this.#frame !== 0) return;
    this.#frame = requestAnimationFrame((now) => {
      this.#frame = 0;
      this.#predictor.tick(performance.now());
      this.#changed();
      if (now < this.#tickUntil) this.#schedule();
    });
  }

  #changed(): void {
    const shown = this.#predictor.visible();
    const flagging = this.#predictor.underlined;
    if (shown === this.#shown && flagging === this.#flagging) return;
    this.#shown = shown;
    this.#flagging = flagging;
    for (const listener of this.#listeners) listener();
  }
}
