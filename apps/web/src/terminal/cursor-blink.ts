import { after, type Timer } from "./output-pacer.ts";

/** How long each phase of a blinking cursor lasts: on for half a second, off for half a second, as wterm's CSS did. */
export const BLINK_PHASE_MS = 500;

/** What decides whether a terminal's cursor blinks right now. */
export interface BlinkState {
  /** The terminal has focus (wterm's `.focused`, or `:active` while a press on it lasts). */
  readonly focused: boolean;
  /** Blinking was asked for by the config (wterm's `.cursor-blink`). */
  readonly blinkAsked: boolean;
  /** Steady was asked for by the config (wterm's `.cursor-steady`), which overrides a program's choice. */
  readonly steadyAsked: boolean;
  /** The program's cursor style blinks (the grid's `data-cursor-blink`, from DECSCUSR). */
  readonly programBlinks: boolean;
  /** The window can be seen; a hidden window's cursor stays drawn and nothing is flipped. */
  readonly visible: boolean;
}

/** wterm's own rule for a blinking cursor (terminal.css), and only while the window can be seen. */
export function cursorBlinks(state: BlinkState): boolean {
  if (!state.focused || !state.visible) return false;
  return state.blinkAsked || (!state.steadyAsked && state.programBlinks);
}

/**
 * Which animation blinked the cursor, each drawing its phases differently (styles.css): wterm's `cursor-blink` for a
 * block, its `cursor-line-blink` for a bar or underline, the config's `doriface-hollow-blink` for a block_hollow.
 */
export type CursorKind = "block" | "line" | "hollow";

/** The kind from the grid's `data-cursor-shape` and the root's `cursor-hollow`, as the CSS chose the animation. */
export function cursorKind(shape: string | undefined, hollow: boolean): CursorKind {
  if (shape === "bar" || shape === "underline") return "line";
  return hollow ? "hollow" : "block";
}

export interface CursorState extends BlinkState {
  readonly kind: CursorKind;
}

/** A blinking cursor's phase; a cursor that does not blink has none. */
export type CursorPhase = "on" | "off";

/**
 * A cursor's blink, on and off every {@link BLINK_PHASE_MS}, with one timer booked only while it blinks. wterm's CSS
 * animation started over whenever the cursor's span was rebuilt or the animation's name changed (a new
 * {@link CursorKind}), showing the cursor on at once; {@link restart} and a change of kind are those moments. Each
 * phase reads the state again, so an event that never came (a press whose release went to a context menu) is put
 * right within one phase; nothing is read while the cursor does not blink.
 */
export class CursorBlink {
  readonly #read: () => CursorState;
  readonly #draw: (phase: CursorPhase | null) => void;
  readonly #watch: (blinking: boolean) => void;
  readonly #timer: Timer;
  #phase: CursorPhase | null = null;
  #kind: CursorKind = "block";
  #cancel: (() => void) | null = null;

  /**
   * `read` takes the state now; `draw` marks the phase (null: not blinking); `watch` is told when blinking starts and
   * stops, to watch the cursor's span for being rebuilt only meanwhile.
   */
  constructor(
    read: () => CursorState,
    draw: (phase: CursorPhase | null) => void,
    watch: (blinking: boolean) => void,
    timer: Timer = after,
  ) {
    this.#read = read;
    this.#draw = draw;
    this.#watch = watch;
    this.#timer = timer;
  }

  get blinking(): boolean {
    return this.#cancel !== null;
  }

  /** Takes the state again: starts or stops blinking, or starts the phase over for a new kind. */
  decide(): void {
    this.#settle(this.#read(), false);
  }

  /** The cursor's span was rebuilt: a blinking cursor shows on at once, with a whole on phase. */
  restart(): void {
    if (this.blinking) this.#start();
  }

  /** Stops blinking and leaves the cursor unmarked. */
  stop(): void {
    if (this.#cancel === null) return;
    this.#cancel();
    this.#cancel = null;
    this.#show(null);
    this.#watch(false);
  }

  /** `tick`: the phase is over, so it flips unless the state now says otherwise. */
  #settle(state: CursorState, tick: boolean): void {
    if (!cursorBlinks(state)) return this.stop();
    const fresh = !this.blinking;
    if (fresh || state.kind !== this.#kind) {
      this.#kind = state.kind;
      this.#start();
      if (fresh) this.#watch(true);
    } else if (tick) {
      this.#show(this.#phase === "on" ? "off" : "on");
      this.#arm();
    }
  }

  #start(): void {
    this.#cancel?.();
    this.#show("on");
    this.#arm();
  }

  #arm(): void {
    this.#cancel = this.#timer(() => this.#settle(this.#read(), true), BLINK_PHASE_MS);
  }

  #show(phase: CursorPhase | null): void {
    if (phase === this.#phase) return;
    this.#phase = phase;
    this.#draw(phase);
  }
}

/**
 * Blinks the terminal's cursor by `data-cursor-on` / `data-cursor-off` (styles.css) instead of wterm's CSS animation,
 * which made Chromium recalculate style and paint every frame, 60 times a second, for a blink that changes twice a
 * second. Nothing runs while the cursor does not blink: the answer is taken again only when something it depends on
 * changes (the root's classes, the grid's shape and blink, the window's visibility and focus, a press on the terminal).
 * While it blinks, and only then, the grid is watched for the cursor's span being rebuilt; at most the focused terminal
 * blinks, so that is one watcher at a time. Returns how to stop.
 */
export function blinkCursor(element: HTMLElement, timer: Timer = after): () => void {
  // wterm's constructor appends the grid before the element is handed out, and it lives as long as the terminal.
  const grid = element.querySelector<HTMLElement>(".term-grid");
  if (grid === null) throw new Error("a wterm element has no .term-grid");
  const document = element.ownerDocument;
  const view = document.defaultView;
  let cursor: Element | null = null;
  const rebuilt = new MutationObserver(() => {
    const now = grid.querySelector(".term-cursor");
    if (now === cursor) return;
    cursor = now;
    blink.restart();
  });
  const blink = new CursorBlink(
    // The browser's `:active` is the press, as wterm's CSS reads it: set already inside pointerdown, cleared by the
    // release wherever it lands, and never stuck on a release that went elsewhere.
    () => ({
      focused: element.classList.contains("focused") || element.matches(":active"),
      blinkAsked: element.classList.contains("cursor-blink"),
      steadyAsked: element.classList.contains("cursor-steady"),
      programBlinks: grid.dataset["cursorBlink"] === "true",
      visible: document.visibilityState === "visible",
      kind: cursorKind(grid.dataset["cursorShape"], element.classList.contains("cursor-hollow")),
    }),
    (phase) => {
      element.toggleAttribute("data-cursor-on", phase === "on");
      element.toggleAttribute("data-cursor-off", phase === "off");
    },
    (blinking) => {
      if (blinking) {
        cursor = grid.querySelector(".term-cursor");
        rebuilt.observe(grid, { childList: true, subtree: true });
      } else rebuilt.disconnect();
    },
    timer,
  );
  const decide = (): void => blink.decide();

  const settings = new MutationObserver(decide);
  settings.observe(element, { attributes: true, attributeFilter: ["class"] });
  settings.observe(grid, { attributes: true, attributeFilter: ["data-cursor-blink", "data-cursor-shape"] });
  document.addEventListener("visibilitychange", decide);
  view?.addEventListener("blur", decide);
  element.addEventListener("pointerdown", decide);
  element.addEventListener("contextmenu", decide);
  document.addEventListener("pointerup", decide);
  document.addEventListener("pointercancel", decide);
  decide();
  return () => {
    settings.disconnect();
    document.removeEventListener("visibilitychange", decide);
    view?.removeEventListener("blur", decide);
    element.removeEventListener("pointerdown", decide);
    element.removeEventListener("contextmenu", decide);
    document.removeEventListener("pointerup", decide);
    document.removeEventListener("pointercancel", decide);
    blink.stop();
  };
}
