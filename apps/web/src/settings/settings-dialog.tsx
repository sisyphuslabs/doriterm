import { cn } from "@doriface/ui";
import { useRouter } from "@tanstack/react-router";
import { createContext, use, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { SHEET_OUT, useLeaveMotion } from "../workspace/leave-motion.ts";
import { BACK_MOTION } from "../workspace/phone-back-motion.ts";
import { useSettingsClose } from "./use-close-settings.ts";

/** Settings is drawn in the dialog over the workspace (the desktop layout), not as the full-screen sheet of a phone. */
export const SettingsInDialog = createContext(false);

export const useSettingsInDialog = (): boolean => use(SettingsInDialog);

/** Narrower than md (the phone shell), or too short for the dialog, such as a phone held in landscape. */
const SHEET_QUERY = "(max-width: 767.98px), (max-height: 599.98px)";

/**
 * Whether Settings takes the whole screen as a sheet instead of a dialog over the workspace: on a phone, and on any screen
 * too short to hold the dialog, where the sheet also keeps its controls out of the safe-area insets.
 */
export function useSettingsSheet(): boolean {
  return useSyncExternalStore(
    (listener) => {
      const media = matchMedia(SHEET_QUERY);
      media.addEventListener("change", listener);
      return () => media.removeEventListener("change", listener);
    },
    () => matchMedia(SHEET_QUERY).matches,
  );
}

/**
 * Whether Settings was left, rather than switched between sheet and dialog by a resize: only a Settings the person left
 * plays its leave (DESIGN.md 6, Leaving).
 */
function useSettingsLeft(): () => boolean {
  const router = useRouter();
  return () => router.state.location.pathname !== "/settings";
}

/**
 * Settings on a phone, or a screen too short for the dialog: a modal sheet over the whole screen, pushed in from the
 * trailing edge as any phone screen is, and slid off again as Back slides one (DESIGN.md 6, Settings).
 */
export function SettingsSheet({ children }: { readonly children: ReactNode }) {
  const sheet = useRef<HTMLDivElement>(null);
  useLeaveMotion(
    sheet,
    { keyframes: [{ transform: "translateX(0)" }, { transform: "translateX(100%)" }], timing: BACK_MOTION },
    useSettingsLeft(),
  );
  return (
    // No z-index: a menu or dialog Settings portals to the body paints in DOM order, and a layer above it would
    // cover the menu (the workspace behind is invisible, so this layer only has to paint over nothing). It is a modal
    // dialog named Settings, as the wide screen's is: the workspace under it is hidden from assistive tech, so the
    // sheet is the page's one landmark (#1378).
    <div
      ref={sheet}
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      data-settings-sheet
      className="motion-arrive fixed inset-0 bg-background [--arrive-duration:var(--duration-push)] [--arrive-ease:var(--ease-standard)] [--arrive-from:translateX(100%)]"
    >
      {children}
    </div>
  );
}

/**
 * Settings over the workspace on a wide screen: the terminals stay in view behind a dimmed backdrop and keep drawing
 * what their programs print, so a change to the theme, density or text size shows on them as it is made. A click on the
 * backdrop closes it, as Escape does. Focus moves into the dialog when it opens.
 */
export function SettingsDialog({ children }: { readonly children: ReactNode }) {
  const close = useSettingsClose();
  const backdrop = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const left = useSettingsLeft();
  // The backdrop's picture first, so the panel's paints over it.
  useLeaveMotion(backdrop, { keyframes: [{ opacity: 1 }, { opacity: 0 }], timing: SHEET_OUT }, left);
  useLeaveMotion(
    panel,
    {
      keyframes: [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: "scale(0.97)" },
      ],
      timing: SHEET_OUT,
    },
    left,
  );
  useLayoutEffect(() => {
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus({ preventScroll: true });
  }, []);
  return (
    <SettingsInDialog value>
      {/* The modal level of the ui kit's own dialogs (z-50), so nothing in the workspace paints over it. */}
      <div
        ref={backdrop}
        aria-hidden
        className="motion-arrive fixed inset-0 z-50 bg-black/40 [--arrive-from:none]"
        onClick={close}
      />
      {/* The window's own titlebar band over the backdrop: it moves the desktop window and starts past its buttons even
          while the workspace behind has drawn no titlebar of its own yet (Settings opened as the first screen). Outside
          the desktop app it is still backdrop: a click on it closes Settings. */}
      <div
        aria-hidden
        data-titlebar
        className="fixed inset-x-0 top-0 z-50 h-11 pl-(--titlebar-inset-start,0px)"
        onClick={close}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        data-settings-dialog
        className={cn(
          // no-drag: in the desktop app a titlebar row under the panel would otherwise take its clicks to move the
          // window, since overlapping drag regions resolve in DOM order whatever paints on top.
          "z-50 [-webkit-app-region:no-drag]",
          "fixed inset-x-0 top-[6vh] mx-auto h-[min(88vh,48rem)] w-[min(calc(100vw-3rem),64rem)] overflow-hidden",
          "rounded-xl border border-border bg-background shadow-overlay outline-none",
          // Arrival as an overlay's (DESIGN.md 6): from 0.97 and transparent, over --duration-standard on --ease-out.
          "motion-arrive",
        )}
      >
        {children}
      </div>
    </SettingsInDialog>
  );
}
