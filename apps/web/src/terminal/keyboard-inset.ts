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

const typingIn = (scope: HTMLElement | null): boolean => {
  const active = document.activeElement;
  return scope !== null && active instanceof HTMLTextAreaElement && scope.contains(active);
};

/**
 * The soft keyboard over `scope`: whether it is up for a terminal in it, and its inset. On a touch screen it is up only
 * while a terminal has the text focus and the keyboard takes room (a focus without a tap raises none on iOS); with a
 * fine pointer there is no soft keyboard, so the text focus alone counts. A keyboard that closes by its own key while
 * the terminal keeps focus (Android's back, iPadOS's hide key) blurs the terminal, so the page agrees with the screen.
 */
export function useSoftKeyboard(scope: HTMLElement | null): { readonly up: boolean; readonly inset: number } {
  const [typing, setTyping] = useState(false);
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    const follow = (): void => queueMicrotask(() => setTyping(typingIn(scope)));
    document.addEventListener("focusin", follow, { signal: abort.signal });
    document.addEventListener("focusout", follow, { signal: abort.signal });
    follow();
    const viewport = window.visualViewport;
    let last = 0;
    const measure = (): void => {
      if (viewport === null) return;
      const next = keyboardInset(window.innerHeight, viewport);
      if (last > 0 && next === 0 && typingIn(scope) && document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      last = next;
      setInset(next);
    };
    viewport?.addEventListener("resize", measure, { signal: abort.signal });
    viewport?.addEventListener("scroll", measure, { signal: abort.signal });
    measure();
    return () => abort.abort();
  }, [scope]);
  const touch = window.matchMedia("(pointer: coarse)").matches;
  return { up: typing && (inset > 0 || !touch), inset };
}
