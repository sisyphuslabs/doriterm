import { HcRpcError, type MachineView, type TerminalRunParams } from "@doriface/protocol";
import { offlineReason, stateReason } from "./machine-state.ts";

export interface RunFailure {
  readonly machine: string;
  readonly kind: string;
  readonly message: string;
}

export type Started =
  | { readonly ok: true; readonly address: string }
  | { readonly ok: false; readonly failure: RunFailure };

/**
 * New terminal anywhere: `on` names an added machine, else it starts on this core. Read shown states when a refusal
 * arrives, not when the request starts: a drop, login request or grace expiry may happen while the run is in flight.
 */
export async function startTerminal(
  run: (params: TerminalRunParams) => Promise<{ readonly address: string }>,
  params: TerminalRunParams,
  local: { readonly name: string; readonly shown: () => readonly MachineView[] },
): Promise<Started> {
  const machine = params.on ?? local.name;
  try {
    return { ok: true, address: (await run(params)).address };
  } catch (error) {
    if (error instanceof HcRpcError) {
      const view = local.shown().find((one) => one.name === machine);
      const message =
        error.kind === "unavailable" && view?.state !== "connected"
          ? view === undefined
            ? offlineReason(machine)
            : stateReason(view.state, view.name)
          : error.kind === "machine_unknown"
            ? `${machine} is no longer added here`
            : error.message;
      return {
        ok: false,
        failure: { machine, kind: error.kind, message },
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
