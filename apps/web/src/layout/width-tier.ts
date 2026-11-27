import { useSyncExternalStore } from "react";

/**
 * The shell's three widths (design proposal section 4): compact is the phone shell (a phone, an iPad's 1/3 Split View,
 * a folded foldable), medium is the desktop shell with its sidebar as a rail (an iPad in portrait, a foldable open),
 * wide is the desktop shell as it is (an iPad in landscape, a desktop).
 */
export type WidthTier = "compact" | "medium" | "wide";

export const MEDIUM_MIN = 600;
export const WIDE_MIN = 1024;

export interface TierInput {
  /** The window's width, CSS px. */
  readonly width: number;
  /** The screen's size, CSS px: unlike the window, a soft keyboard never shrinks it. */
  readonly screen: { readonly width: number; readonly height: number };
  /** Whether the primary pointer is a finger. */
  readonly coarse: boolean;
}

/**
 * The tier of a window. A touch screen whose short side is under 600 is a phone, and stays the phone shell turned on
 * its side, so rotating keeps its keys bar and its split focus (P9); a mouse window of the same width is medium.
 */
export function widthTier({ width, screen, coarse }: TierInput): WidthTier {
  if (width < MEDIUM_MIN) return "compact";
  if (coarse && Math.min(screen.width, screen.height) < MEDIUM_MIN) return "compact";
  return width < WIDE_MIN ? "medium" : "wide";
}

const COARSE = "(pointer: coarse)";

function subscribe(listener: () => void): () => void {
  const pointer = matchMedia(COARSE);
  window.addEventListener("resize", listener);
  pointer.addEventListener("change", listener);
  return () => {
    window.removeEventListener("resize", listener);
    pointer.removeEventListener("change", listener);
  };
}

/** The window's tier now, outside React (a picture deciding whether it leaves, leave-motion.ts). */
export const currentWidthTier = (): WidthTier =>
  widthTier({
    width: window.innerWidth,
    screen: { width: window.screen.width, height: window.screen.height },
    coarse: matchMedia(COARSE).matches,
  });

/** The window's tier, following resizes, rotation, folding and a pointer change. */
export function useWidthTier(): WidthTier {
  return useSyncExternalStore(subscribe, currentWidthTier);
}

const portrait = (): boolean => window.innerHeight > window.innerWidth;

/** Whether the window is taller than it is wide. */
export function usePortrait(): boolean {
  return useSyncExternalStore(subscribe, portrait);
}
