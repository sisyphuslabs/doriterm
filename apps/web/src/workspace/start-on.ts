import { HcRpcError, type TerminalRunParams } from "@doriface/protocol";
import { offlineReason } from "./machine-state.ts";

export interface RunFailure {
  readonly machine: string;
  readonly kind: string;
  readonly message: string;
}

export type Started =
  | { readonly ok: true; readonly address: string }
  | { readonly ok: false; readonly failure: RunFailure };

const ADVICE: Readonly<Record<string, (machine: string) => string>> = {
  unavailable: offlineReason,
  machine_unknown: (machine) => `${machine} is no longer added here`,
};

/**
 * New terminal anywhere: `on` names an added machine, else it starts on this one (`localName`). Every failure comes
 * back as one naming the machine, a closed connection included, so the caller reports it instead of dropping it.
 */
export async function startTerminal(
  run: (params: TerminalRunParams) => Promise<{ readonly address: string }>,
  params: TerminalRunParams,
  localName: string,
): Promise<Started> {
  const machine = params.on ?? localName;
  try {
    return { ok: true, address: (await run(params)).address };
  } catch (error) {
    if (error instanceof HcRpcError) {
      return {
        ok: false,
        failure: { machine, kind: error.kind, message: ADVICE[error.kind]?.(machine) ?? error.message },
      };
    }
    return {
      ok: false,
      failure: { machine, kind: "connection", message: error instanceof Error ? error.message : String(error) },
    };
  }
}

/** What a failed New terminal tells the user; while the link is down the cause is the reconnect, not the machine. */
export function failureNotice(
  failure: RunFailure,
  reconnecting: boolean,
  core: string,
): { readonly title: string; readonly description: string } {
  return {
    title: "Could not open a new tab",
    description: reconnecting ? `Reconnecting to ${core}; try again once it is back.` : failure.message,
  };
}
