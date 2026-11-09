import type { Page } from "@playwright/test";

/**
 * Call before page.goto: a soft keyboard that follows iOS WebKit's input session rather than the focus alone (#1941).
 *
 * - A text field focused inside a tap starts a session that shows an input view; the keyboard rises unless the field
 *   carries `inputmode="none"` at that focus.
 * - Changing `inputmode` reaches the session only while the field has the focus (WebKit's
 *   `focusedElementDidChangeInputMode` drops a change on a field that is not focused).
 * - A field let go and focused again in the same task, while its session shows an input view, keeps that session as it
 *   was (`shouldDispatchUpdateAfterFocusingElement`): its `inputmode` is not read again.
 * - A session whose field stays let go past that task ends, and the keyboard goes down with it.
 *
 * `window.softKeyboard(0)` closes the keyboard by its own key, which blurs the field as iOS does.
 */
export async function iosInputSession(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface Session {
      readonly field: HTMLTextAreaElement;
      mode: string;
      readonly showing: boolean;
    }
    let keyboard = 0;
    let tapping = false;
    let session: Session | null = null;
    let recentlyBlurred: HTMLTextAreaElement | null = null;
    const viewport = Object.defineProperties(new EventTarget(), {
      height: { get: (): number => window.innerHeight - keyboard },
      width: { get: (): number => window.innerWidth },
      offsetTop: { get: (): number => 0 },
      offsetLeft: { get: (): number => 0 },
      pageTop: { get: (): number => window.scrollY },
      pageLeft: { get: (): number => window.scrollX },
      scale: { get: (): number => 1 },
    });
    Object.defineProperty(window, "visualViewport", { get: () => viewport });
    const settle = (): void => {
      const px = session !== null && session.showing && session.mode !== "none" ? 336 : 0;
      if (px === keyboard) return;
      keyboard = px;
      viewport.dispatchEvent(new Event("resize"));
    };
    for (const type of ["touchstart", "touchend", "pointerdown", "pointerup", "mousedown", "mouseup", "click"]) {
      window.addEventListener(
        type,
        () => {
          tapping = true;
          setTimeout(() => (tapping = false), 0);
        },
        true,
      );
      window.addEventListener(type, () => (tapping = false));
    }
    const inputMode = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "inputMode");
    Object.defineProperty(HTMLElement.prototype, "inputMode", {
      configurable: true,
      get(this: HTMLElement) {
        return inputMode?.get?.call(this);
      },
      set(this: HTMLElement, mode: string) {
        inputMode?.set?.call(this, mode);
        if (session !== null && session.field === this && document.activeElement === this) {
          session.mode = mode;
          settle();
        }
      },
    });
    document.addEventListener("focusin", (event) => {
      const field = event.target;
      if (!(field instanceof HTMLTextAreaElement)) return;
      if (recentlyBlurred === field && session !== null && session.field === field && session.showing) {
        recentlyBlurred = null;
        return;
      }
      recentlyBlurred = null;
      session = { field, mode: field.inputMode, showing: tapping || keyboard > 0 };
      settle();
    });
    document.addEventListener("focusout", (event) => {
      const field = event.target;
      if (!(field instanceof HTMLTextAreaElement) || session?.field !== field) return;
      recentlyBlurred = field;
      setTimeout(() => {
        if (recentlyBlurred !== field) return;
        recentlyBlurred = null;
        session = null;
        settle();
      }, 0);
    });
    const closeByOwnKey = (px: number): void => {
      if (px === 0) session?.field.blur();
    };
    Object.assign(window, { softKeyboard: closeByOwnKey });
  });
}
