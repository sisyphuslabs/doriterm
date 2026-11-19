import { after, type Timer } from "./output-pacer.ts";

/** How long each phase of a blinking cursor lasts: on for half a second, off for half a second, as wterm's CSS did. */
export const BLINK_PHASE_MS = 500;

/** What decides whether a terminal's cursor blinks right now. */
export interface BlinkState {
  /** The terminal has focus (wterm's `.focused`, or a press on it in progress). */
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
 * The phase of a blinking cursor, on and off every {@link BLINK_PHASE_MS}, with one timer booked only while it blinks.
 * wterm's CSS animation started over whenever the cursor's span was rebuilt, so a cursor that had just moved showed on
 * at once; {@link restart} is that moment.
 */
export class BlinkPhase {
  readonly #draw: (off: boolean) => void;
  readonly #timer: Timer;
  #off = false;
  #cancel: (() => void) | null = null;

  /** `draw` shows the phase: off is the cell as it is, on is the cursor. */
  constructor(draw: (off: boolean) => void, timer: Timer = after) {
    this.#draw = draw;
    this.#timer = timer;
  }

  get blinking(): boolean {
    return this.#cancel !== null;
  }

  /** Draws the cursor on now and gives it a whole on phase, blinking from here. */
  restart(): void {
    this.#cancel?.();
    this.#show(false);
    this.#arm();
  }

  /** Stops blinking and leaves the cursor drawn on. */
  stop(): void {
    this.#cancel?.();
    this.#cancel = null;
    this.#show(false);
  }

  #arm(): void {
    this.#cancel = this.#timer(() => {
      this.#show(!this.#off);
      this.#arm();
    }, BLINK_PHASE_MS);
  }

  #show(off: boolean): void {
    if (off === this.#off) return;
    this.#off = off;
    this.#draw(off);
  }
}

/**
 * Blinks the terminal's cursor by `data-cursor-off` (styles.css) instead of wterm's CSS animation, which made Chromium
 * recalculate style and paint every frame, 60 times a second, for a blink that changes twice a second. Nothing runs
 * while the cursor does not blink: the answer is taken again only when something it depends on changes (the root's
 * classes, the program's blink, the window's visibility, a press on the terminal). While it blinks, and only then, the
 * grid is watched for the cursor's span being rebuilt, which starts the phase over as wterm's animation did; at most
 * the focused terminal blinks, so that is one watcher at a time. Returns how to stop.
 */
export function blinkCursor(element: HTMLElement, timer: Timer = after): () => void {
  // wterm's constructor appends the grid before the element is handed out, and it lives as long as the terminal.
  const grid = element.querySelector<HTMLElement>(".term-grid");
  if (grid === null) throw new Error("a wterm element has no .term-grid");
  const document = element.ownerDocument;
  const phase = new BlinkPhase((off) => element.toggleAttribute("data-cursor-off", off), timer);
  let pressed = false;
  let cursor: Element | null = null;

  const rebuilt = new MutationObserver(() => {
    const now = grid.querySelector(".term-cursor");
    if (now === cursor) return;
    cursor = now;
    phase.restart();
  });
  const decide = (): void => {
    const blinks = cursorBlinks({
      focused: pressed || element.classList.contains("focused"),
      blinkAsked: element.classList.contains("cursor-blink"),
      steadyAsked: element.classList.contains("cursor-steady"),
      programBlinks: grid.dataset["cursorBlink"] === "true",
      visible: document.visibilityState === "visible",
    });
    if (blinks === phase.blinking) return;
    if (blinks) {
      cursor = grid.querySelector(".term-cursor");
      rebuilt.observe(grid, { childList: true, subtree: true });
      phase.restart();
    } else {
      rebuilt.disconnect();
      phase.stop();
    }
  };
  // wterm's `:active` case: a primary press on the terminal keeps its cursor active until the press ends anywhere.
  const press = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    pressed = true;
    decide();
  };
  const release = (): void => {
    if (!pressed) return;
    pressed = false;
    decide();
  };

  const settings = new MutationObserver(decide);
  settings.observe(element, { attributes: true, attributeFilter: ["class"] });
  settings.observe(grid, { attributes: true, attributeFilter: ["data-cursor-blink"] });
  document.addEventListener("visibilitychange", decide);
  element.addEventListener("pointerdown", press);
  document.addEventListener("pointerup", release);
  document.addEventListener("pointercancel", release);
  decide();
  return () => {
    settings.disconnect();
    rebuilt.disconnect();
    document.removeEventListener("visibilitychange", decide);
    element.removeEventListener("pointerdown", press);
    document.removeEventListener("pointerup", release);
    document.removeEventListener("pointercancel", release);
    phase.stop();
  };
}
