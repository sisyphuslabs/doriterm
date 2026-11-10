import { useContext, useEffect } from "react";
import { ActionsPaused } from "../keys/dispatcher.ts";
import { desktopNotices } from "./desktop-notices.ts";
import { pushChannel } from "./push-channel.ts";

const seen = (): boolean => document.visibilityState === "visible" && document.hasFocus();

/** Where the shown pane is reported: the host's push stream, and the desktop app's own notifications where it runs. */
export interface PresenceSink {
  focus(terminal: string | null): void;
}

/** The pane this device reports as shown: none under Settings, sheet or dialog alike, and none while the page is unseen. */
export function shownPane(terminal: string | null, underSettings: boolean, pageSeen: boolean): string | null {
  return underSettings || !pageSeen ? null : terminal;
}

/** Tells every sink the same pane, so the push and the desktop app's notices hold back about the same one. */
export function reportShown(shown: string | null, sinks: readonly (PresenceSink | null)[]): void {
  for (const sink of sinks) sink?.focus(shown);
}

const SINKS: readonly (PresenceSink | null)[] = [pushChannel, desktopNotices];

/**
 * Tells the host which pane this device shows while the page is visible and focused, so it sends no push about it; the
 * desktop app's own notifications hold back the same way. Under Settings no pane counts as shown: the workspace stays
 * mounted there, as a full-screen sheet's hidden layer or behind the dialog, where it still draws but is inert, and a
 * pane the workspace still calls focused is not one anyone is watching (#993).
 *
 * `sinks` is an effect dependency: pass a stable array (a module constant, or memoized), since a new array each render
 * re-runs the effect and sends a no-pane report and the pane again every render.
 */
export function usePushPresence(terminal: string | null, sinks: readonly (PresenceSink | null)[] = SINKS): void {
  const underSettings = useContext(ActionsPaused);
  const inView = shownPane(terminal, underSettings, true);
  useEffect(() => {
    const report = (): void => reportShown(seen() ? inView : null, sinks);
    report();
    document.addEventListener("visibilitychange", report);
    addEventListener("focus", report);
    addEventListener("blur", report);
    return () => {
      document.removeEventListener("visibilitychange", report);
      removeEventListener("focus", report);
      removeEventListener("blur", report);
      reportShown(null, sinks);
    };
  }, [inView, sinks]);
}
