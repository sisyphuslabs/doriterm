import { cn } from "@doriface/ui";
import { createContext, use, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
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
 * Settings over the workspace on a wide screen: the terminals stay in view behind a dimmed backdrop and keep drawing
 * what their programs print, so a change to the theme, density or text size shows on them as it is made. A click on the
 * backdrop closes it, as Escape does. Focus moves into the dialog when it opens.
 */
export function SettingsDialog({ children }: { readonly children: ReactNode }) {
  const close = useSettingsClose();
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus({ preventScroll: true });
  }, []);
  return (
    <SettingsInDialog value>
      {/* The modal level of the ui kit's own dialogs (z-50), so nothing in the workspace paints over it. */}
      <div aria-hidden className="fixed inset-0 z-50 bg-black/40" onClick={close} />
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
        )}
      >
        {children}
      </div>
    </SettingsInDialog>
  );
}
