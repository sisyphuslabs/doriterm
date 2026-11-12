import type { HcConnection } from "@doriface/client";
import { useToastManager } from "@doriface/ui";
import { useEffect, useRef } from "react";
import { ResumeAbandonedError } from "../connection/session-resume.ts";
import { useConnection } from "../connection/store.ts";
import { HISTORY_LINES } from "../terminal/opening-attach.ts";

/**
 * A reconnect that could not carry the session on (contract v1.11) opens a new one, and every terminal is then redrawn
 * from its host rather than continued: the screen and its last {@link HISTORY_LINES} lines. That is said once, when the
 * new connection arrives, so the redraw is never a silent gap in what the reader was looking at.
 */
export function useRedrawNotice(connection: HcConnection): void {
  const toasts = useToastManager();
  const state = useConnection();
  const abandoned = useRef(false);
  useEffect(() => {
    if (state.phase === "failed" && state.error instanceof ResumeAbandonedError) abandoned.current = true;
  }, [state]);
  useEffect(() => {
    if (!abandoned.current) return;
    abandoned.current = false;
    toasts.add({
      type: "info",
      title: "Reconnected",
      description: `The session could not be carried on, so each terminal was redrawn from its host: the screen and its last ${HISTORY_LINES.toLocaleString()} lines.`,
    });
  }, [connection, toasts]);
}
