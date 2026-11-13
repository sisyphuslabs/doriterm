import type { HcConnection } from "@doriface/client";
import { useEffect, useRef, useState } from "react";
import { connectionStore } from "../connection/store.ts";
import { AttachRecovery, type RecoveryState } from "./attach-recovery.ts";
import { openFailure } from "./open-failure.ts";
import { recordRecovery } from "./recovery-metrics.ts";
import { useReopenWhenMoved } from "./use-reopen-when-moved.ts";

interface RecoverySources {
  readonly connection: HcConnection;
  readonly address: string;
  readonly shown: boolean;
  readonly retry: () => void;
}

/** Binds a pane's recovery budget to its current address, visibility, and user interactions. */
export function useAttachRecovery({ connection, address, shown, retry }: RecoverySources) {
  const [state, setState] = useState<RecoveryState>({ phase: "idle" });
  const latestRetry = useRef(retry);
  latestRetry.current = retry;
  const [recovery] = useState(() => new AttachRecovery(() => latestRetry.current(), setState));
  const unopened = state.phase === "failed" ? openFailure(address, state.cause) : null;
  const unopenedAt = useReopenWhenMoved(address, unopened, () => {
    recovery.reset();
    latestRetry.current();
  });
  const errorVisible = useRef(false);
  useEffect(() => {
    const visible = state.phase === "failed" && shown;
    if (visible && !errorVisible.current) recordRecovery("errorsShown");
    errorVisible.current = visible;
  }, [state, shown]);
  useEffect(() => () => recovery.stop(), [connection, address, recovery]);
  const wasShown = useRef(shown);
  useEffect(() => {
    if (shown && !wasShown.current) recovery.shown();
    wasShown.current = shown;
  }, [shown, recovery]);
  return {
    recovery,
    unopened,
    reconnecting: state.phase === "reconnecting",
    failed: (cause: unknown): void => {
      unopenedAt(address);
      recovery.failed(cause);
    },
    interact: (): void => {
      const advanced = recovery.interact();
      if (connection.closed && advanced) {
        const member = connectionStore
          .entries()
          .find(({ state: line }) => line.phase === "failed" && line.stale === connection && line.retryInMs !== null);
        // Advance only this pane's waiting socket. Typing must not abort an in-flight dial or probe other members, and a
        // refused early dial must not climb the back-off, or a blip typed through waits the longest delay (#2266).
        if (member !== undefined) connectionStore.nudge(member.target.hostId);
      }
    },
  };
}
