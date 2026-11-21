import { HcCoreMismatchError, type HcCoreMismatch } from "@doriface/client";
import { DeviceNotPairedError, LoopbackTokenError } from "./connect.ts";
import { LoopbackAddressError } from "./loopback-address.ts";

const BY_CODE: Readonly<Record<number, string>> = {
  4400: "The secure connection to your host failed. If the host was set up again, pair this device again.",
  4403: "Your host's identity was refused. Restart doriface-host on it.",
  4404: "Your host isn't connected right now. Check that its computer is awake and doriface-host is running.",
  4408: "Your host didn't answer in time. It may be busy or on a slow network.",
  4429: "There were too many attempts in a short time. Wait a minute.",
};

const FALLBACK = "Your host isn't answering. Check that its computer is on and doriface-host is running.";

/** A core this client cannot use: which side to update, and how (#651). */
function coreMismatch(mismatch: HcCoreMismatch): string {
  switch (mismatch.kind) {
    case "core-too-old":
      return `Your host's herdr-core is ${mismatch.version}, and Doriterm needs ${mismatch.need} or newer. Run hc update on that computer.`;
    case "core-older":
      return `Your host's herdr-core is too old for Doriterm, which needs ${mismatch.need} or newer. Run hc update on that computer.`;
    case "core-missing":
      return `Your host's herdr-core is missing ${mismatch.methods.join(", ")}, which Doriterm needs. Run hc update on that computer.`;
    case "core-newer":
      return "Your host's herdr-core is newer than this Doriterm understands. Update Doriterm.";
  }
}

/** Why this device cannot reach its host, in plain words: the close code decides, never the transport's message. */
export function hostFailure(error: Error): string {
  if (
    error instanceof DeviceNotPairedError ||
    error instanceof LoopbackAddressError ||
    error instanceof LoopbackTokenError
  )
    return error.message;
  if (error instanceof HcCoreMismatchError) return coreMismatch(error.mismatch);
  const code = "code" in error && typeof error.code === "number" ? error.code : undefined;
  return (code === undefined ? undefined : BY_CODE[code]) ?? FALLBACK;
}

/**
 * A failure a retry cannot fix: the host does not know this device, the address is not on this computer, this
 * computer's host turned the token down, or its core has to be updated on one side or the other (#462, #515, #651,
 * #2003). None of them is helped by dialing again.
 */
export function isFinal(error: Error): boolean {
  return (
    error instanceof DeviceNotPairedError ||
    error instanceof LoopbackAddressError ||
    error instanceof LoopbackTokenError ||
    error instanceof HcCoreMismatchError
  );
}
