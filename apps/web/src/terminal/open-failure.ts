import { HcRpcError } from "@doriface/protocol";
import { HcConnectionClosedError, HcHandshakeTimeoutError, HcLinkSilentError, HcTimeoutError } from "@doriface/client";
import { TerminalStreamLostError } from "./attach-recovery.ts";

/** Why a terminal could not be attached, in plain words: hc's message names its dialer and its error class. */
export function openFailure(address: string, cause: unknown): string {
  if (cause instanceof HcTimeoutError || cause instanceof HcHandshakeTimeoutError)
    return "The host did not answer the terminal connection request in time.";
  if (cause instanceof HcConnectionClosedError || cause instanceof HcLinkSilentError)
    return "The connection to this terminal dropped before it could recover.";
  if (cause instanceof TerminalStreamLostError)
    return "The terminal's output stream ended while its program was still running.";
  if (cause instanceof HcRpcError) {
    if (["unauthorized", "forbidden", "permission_denied", "auth_rejected"].includes(cause.kind))
      return "Access to this terminal was refused. Check this device's access before trying again.";
    if (["invalid_request", "invalid_params", "unknown_method", "parse_error"].includes(cause.kind))
      return "The host rejected the terminal request. Check that Doriterm and the host are up to date.";
    if (cause.kind === "not_found")
      return "The host could not find this terminal or its machine. Check that it still exists.";
  }
  const slash = address.indexOf("/");
  const machine = slash === -1 ? undefined : address.slice(0, slash);
  if (
    cause instanceof HcRpcError &&
    machine !== undefined &&
    /unavailable|unreachable/.test(`${cause.kind} ${cause.message}`)
  ) {
    return `${machine} can't be reached right now, so this terminal can't open.`;
  }
  return "The connection to this terminal failed before it opened.";
}
