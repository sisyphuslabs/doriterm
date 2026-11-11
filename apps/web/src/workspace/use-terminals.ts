import type { HcConnection } from "@doriface/client";
import { useCallback } from "react";
import { machineCount, type TerminalsState } from "../roster/terminals-state.ts";
import { useRoster } from "../roster/use-roster.ts";

export { machineCount, type TerminalsState };

/** The core's terminals as the shared roster's feed shows them, with Try again for a first answer that failed (#819). */
export function useTerminals(connection: HcConnection): TerminalsState & { readonly retry: () => void } {
  const { roster, snapshot } = useRoster(connection);
  const retry = useCallback(() => roster.retryTerminals(), [roster]);
  return { ...snapshot.terminals, retry };
}
