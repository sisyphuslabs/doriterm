import { useState } from "react";
import type { Verdict } from "./mesh-reader.ts";

export interface JoinAnswer {
  /** The answer being sent: its button shows busy, and both stay disabled until the documents are read again. */
  readonly busy: Verdict | undefined;
  /** Why the last answer could not be written. */
  readonly failure: string | undefined;
  readonly send: (verdict: Verdict) => void;
}

/**
 * One join's answer as the person gives it, for the Settings row and the card alike. `onAnswer` settles after the
 * documents are read again, so the buttons stay disabled until the row shows what the approval document holds now; if
 * another writer replaced the answer by then, the join takes an answer again.
 */
export function useJoinAnswer(onAnswer: (verdict: Verdict) => Promise<void>): JoinAnswer {
  const [busy, setBusy] = useState<Verdict | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const send = (verdict: Verdict): void => {
    setBusy(verdict);
    setFailure(undefined);
    onAnswer(verdict).then(
      () => setBusy(undefined),
      (error: unknown) => {
        setBusy(undefined);
        setFailure(error instanceof Error ? error.message : String(error));
      },
    );
  };
  return { busy, failure, send };
}
