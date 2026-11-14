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

function blinkStateOf(element: HTMLElement): BlinkState {
  const grid = element.querySelector<HTMLElement>(".term-grid");
  return {
    focused: element.classList.contains("focused") || element.matches(":active"),
    blinkAsked: element.classList.contains("cursor-blink"),
    steadyAsked: element.classList.contains("cursor-steady"),
    programBlinks: grid?.dataset["cursorBlink"] === "true",
    visible: element.ownerDocument.visibilityState === "visible",
  };
}

/**
 * Blinks the terminal's cursor by flipping `data-cursor-off` every {@link BLINK_PHASE_MS}, instead of wterm's CSS
 * animation: a running CSS animation makes Chromium recalculate style and paint on every frame, 60 times a second,
 * even though a blink changes only twice a second. While the cursor does not blink, the attribute is never set, so an
 * idle terminal changes nothing. Returns how to stop.
 */
export function blinkCursor(element: HTMLElement): () => void {
  let off = false;
  const timer = setInterval(() => {
    const next = cursorBlinks(blinkStateOf(element)) && !off;
    if (next === off) return;
    off = next;
    element.toggleAttribute("data-cursor-off", off);
  }, BLINK_PHASE_MS);
  return () => {
    clearInterval(timer);
    element.removeAttribute("data-cursor-off");
  };
}
