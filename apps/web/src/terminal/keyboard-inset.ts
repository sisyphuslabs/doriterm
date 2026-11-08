import { useEffect, useState } from "react";

export interface ViewportBox {
  readonly height: number;
  readonly offsetTop: number;
  readonly scale: number;
}

/**
 * How far the soft keyboard reaches up from the bottom of the layout viewport, in CSS px: iOS Safari and Chrome on
 * Android shrink the visual viewport over the keyboard and leave the layout viewport alone. A pinch zoom shrinks it
 * too, so a zoomed viewport reads as no keyboard.
 */
export function keyboardInset(layoutHeight: number, viewport: ViewportBox): number {
  if (Math.abs(viewport.scale - 1) > 0.01) return 0;
  return Math.max(0, Math.round(layoutHeight - viewport.height - viewport.offsetTop));
}

/**
 * A layout viewport this much shorter than its tallest at the same width may have a keyboard in it (a browser that
 * resizes the page for the keyboard instead of overlaying it): more than a toolbar collapsing, less than any keyboard.
 */
const LAYOUT_KEYBOARD_MIN = 150;
/** A keyboard comes up within this long of the tap or focus that asked for it; a later shrink is something else. */
export const KEYBOARD_REQUEST_MS = 3000;

/**
 * The keyboard as a browser that resizes the page for it shows it (#244). Kept across screens, so one opened under a
 * keyboard still knows: the tallest page seen at each width (a rotation back finds its own), whether the keyboard is
 * in the page, and when a terminal last asked for it.
 *
 * A shrink counts as the keyboard only right after a terminal asked for one (a tap in it, or its input taking the
 * focus from a tap): entering split screen shrinks the page the same way, with nobody asking, and it becomes the new
 * tallest instead. A rotation with the keyboard up keeps it up until the page grows by a keyboard's height again.
 */
export class LayoutKeyboard {
  readonly #tallest = new Map<number, number>();
  #width = 0;
  #open = false;
  /** After a rotation with the keyboard up: the shortest page since, until it grows back by a keyboard. */
  #floor: number | null = null;
  #askedAt = Number.NEGATIVE_INFINITY;

  /** A terminal asked for the keyboard at `now` (ms). */
  ask(now: number): void {
    this.#askedAt = now;
  }

  /** The page is `width` x `height` at `now` (ms): whether the keyboard is in it. */
  measure(width: number, height: number, now: number): boolean {
    if (width !== this.#width) {
      this.#width = width;
      this.#floor = this.#open && !this.#tallest.has(width) ? height : null;
    }
    if (this.#floor !== null) {
      this.#floor = Math.min(this.#floor, height);
      if (height - this.#floor < LAYOUT_KEYBOARD_MIN) return this.#open;
      this.#floor = null;
    }
    const tallest = Math.max(this.#tallest.get(width) ?? 0, height);
    this.#tallest.set(width, tallest);
    const shrunk = tallest - height >= LAYOUT_KEYBOARD_MIN;
    if (!shrunk) this.#open = false;
    else if (!this.#open) {
      if (now - this.#askedAt <= KEYBOARD_REQUEST_MS) {
        this.#open = true;
        this.#askedAt = Number.NEGATIVE_INFINITY;
      } else this.#tallest.set(width, height);
    }
    return this.#open;
  }
}

const layoutKeyboard = new LayoutKeyboard();

const typingIn = (scope: HTMLElement | null, active: EventTarget | null = document.activeElement): boolean => {
  return scope !== null && active instanceof HTMLTextAreaElement && scope.contains(active);
};

/**
 * The soft keyboard over `scope`: whether it is up for a terminal in it, and its inset over the page. It is up while a
 * terminal has the text focus and the keyboard takes room, whichever way the browser makes it: by shrinking the visual
 * viewport over the page (the inset) or the layout viewport itself (the page is shorter, so the inset stays 0). The
 * focus alone never counts: a focus without a tap raises no keyboard on iOS, and a fine pointer has none to raise, so
 * the keys say Show keyboard until one takes room (#274). A keyboard that closes by its own key while the terminal
 * keeps focus (Android's back, iPadOS's hide key) blurs the terminal, so the page agrees with the screen.
 */
export function useSoftKeyboard(scope: HTMLElement | null): { readonly up: boolean; readonly inset: number } {
  const [typing, setTyping] = useState(false);
  const [keyboard, setKeyboard] = useState({ open: false, inset: 0 });
  useEffect(() => {
    const abort = new AbortController();
    // Native focus moves through body between focusout and focusin. Its destination already names the next field,
    // so switching from the terminal to the fixed input must not unmount that input during the transfer.
    const follow = (event: FocusEvent): void =>
      setTyping(typingIn(scope, event.type === "focusout" ? event.relatedTarget : event.target));
    // A tap in the terminal, or its input taking the focus from one, asks for the keyboard; a focus without a tap does
    // not, as no browser raises a keyboard for it.
    const ask = (): void => layoutKeyboard.ask(performance.now());
    scope?.addEventListener("pointerdown", ask, { signal: abort.signal });
    document.addEventListener(
      "focusin",
      () => {
        if (typingIn(scope) && navigator.userActivation?.isActive !== false) ask();
      },
      { signal: abort.signal },
    );
    document.addEventListener("focusin", follow, { signal: abort.signal });
    document.addEventListener("focusout", follow, { signal: abort.signal });
    setTyping(typingIn(scope));
    const viewport = window.visualViewport;
    let wasOpen = false;
    const measure = (): void => {
      // The layout viewport, which the keys are placed in: WebKit on iOS shrinks window.innerHeight with the visual
      // viewport over the keyboard, so measured from it the keyboard would take no room and hide the keys (#1409).
      const layoutHeight = document.documentElement.clientHeight;
      const inset = viewport === null ? 0 : keyboardInset(layoutHeight, viewport);
      const open = layoutKeyboard.measure(window.innerWidth, layoutHeight, performance.now()) || inset > 0;
      if (wasOpen && !open && typingIn(scope) && document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      wasOpen = open;
      setKeyboard({ open, inset });
    };
    window.addEventListener("resize", measure, { signal: abort.signal });
    viewport?.addEventListener("resize", measure, { signal: abort.signal });
    viewport?.addEventListener("scroll", measure, { signal: abort.signal });
    measure();
    return () => abort.abort();
  }, [scope]);
  return { up: typing && keyboard.open, inset: keyboard.inset };
}

const ANY_TOUCH = "(any-pointer: coarse)";

/**
 * Whether every pointer here is fine (a mouse or trackpad, as on a narrow desktop window): such a device has a physical
 * keyboard and no soft keyboard to raise, so the phone shell opens its keys bar itself (#287).
 */
export function useMouseOnly(): boolean {
  const [mouseOnly, setMouseOnly] = useState(() => !window.matchMedia(ANY_TOUCH).matches);
  useEffect(() => {
    const query = window.matchMedia(ANY_TOUCH);
    const follow = (): void => setMouseOnly(!query.matches);
    query.addEventListener("change", follow);
    follow();
    return () => query.removeEventListener("change", follow);
  }, []);
  return mouseOnly;
}
