const CAPTURE = { capture: true } as const;

/**
 * Whether an input method is composing, for the predictor's `composing()` (HIGH 3(a)). It listens in the capture phase
 * on the terminal element, an ancestor of wterm's textarea, so it flips on `compositionend` before wterm's own
 * target-phase listener commits the syllable through `onData`: the commit is predicted, the composition never is. The
 * preedit's dataset is no gate: it is cleared only after wterm's commit.
 */
export class CompositionGate {
  #composing = false;
  readonly #target: EventTarget;
  readonly #start = (): void => {
    this.#composing = true;
  };
  readonly #end = (): void => {
    this.#composing = false;
  };

  constructor(target: EventTarget) {
    this.#target = target;
    target.addEventListener("compositionstart", this.#start, CAPTURE);
    target.addEventListener("compositionend", this.#end, CAPTURE);
  }

  composing(): boolean {
    return this.#composing;
  }

  dispose(): void {
    this.#target.removeEventListener("compositionstart", this.#start, CAPTURE);
    this.#target.removeEventListener("compositionend", this.#end, CAPTURE);
  }

  /** An `input` event typed while composing (the `typesComposition` path). */
  static fromInputEvent(event: Event): boolean {
    return typeof InputEvent !== "undefined" && event instanceof InputEvent && event.isComposing;
  }
}
