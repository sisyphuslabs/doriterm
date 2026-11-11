import { HcRpcError } from "@doriface/protocol";

/** Why a terminal could not be attached, in plain words: hc's message names its dialer and its error class. */
export function openFailure(address: string, cause: unknown): string {
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
