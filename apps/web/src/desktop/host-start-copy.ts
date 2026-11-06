import type { HostStartFailure } from "./bridge.ts";

export interface HostStartCopy {
  readonly cause: string;
  readonly next: string;
  /** Set when installing herdr-core is the fix. */
  readonly install?: true;
}

export const HERDR_CORE_URL = "https://github.com/herdrdev/herdr-core";

const listOf = (items: readonly string[]): string =>
  items.length === 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;

const AGAIN = "If it keeps happening, Details shows what the host printed.";

/** The words for a failed start, from its code alone: the host's own output stays behind Details. */
export function hostStartCopy(failure: HostStartFailure): HostStartCopy {
  const { path, address, searched } = failure;
  switch (failure.code) {
    case "hc-binary-missing":
      return path === undefined || !/[\\/]/.test(path)
        ? {
            cause: "herdr-core was not found on this computer.",
            // The folders the shell searched on this platform; a desktop app started from the Dock or Start menu reads no
            // HC_BIN, so installing into one of them is the step that works.
            next:
              searched === undefined || searched.length === 0
                ? "Doriterm looks for hc on your PATH. Install herdr-core there, then retry."
                : `Doriterm looks for hc on your PATH and in ${listOf(searched)}. Install herdr-core in one of them, then retry.`,
            install: true,
          }
        : {
            cause: `herdr-core was not found at ${path}.`,
            next: "Install herdr-core there, or point HC_BIN at the hc you have, then retry.",
            install: true,
          };
    case "hc-version-failed":
      return failure.version !== undefined
        ? {
            cause: `${path ?? "hc"} is herdr-core ${failure.version}, older than Doriterm supports.`,
            next: "Update herdr-core, or point HC_BIN at a newer hc, then retry.",
            install: true,
          }
        : {
            cause: `${path ?? "hc"} did not answer as herdr-core.`,
            next: "Install or update herdr-core, or point HC_BIN at the right hc, then retry.",
            install: true,
          };
    case "permission-denied":
      return path !== undefined
        ? {
            cause: `Doriterm may not run ${path}.`,
            next: "Make the file executable, or point HC_BIN at another hc, then retry.",
          }
        : { cause: `Doriterm may not listen on ${address ?? "its port"}.`, next: `Retry. ${AGAIN}` };
    case "port-in-use":
      return {
        cause: `${address ?? "The host's port"} is already in use.`,
        next: "Close the program using it, then retry.",
      };
    case "already-running":
      return {
        cause: "Another Doriterm host is already running on this computer.",
        next: "Quit it (another Doriterm window, or doriface-host in a terminal), then retry.",
      };
    case "host-spawn-failed":
      return {
        cause: "Doriterm could not run its host program.",
        next: "Reinstall Doriterm, then retry. If it keeps happening, Details shows why it could not run.",
      };
    case "host-timeout":
      return { cause: "The host took too long to start.", next: `Retry. ${AGAIN}` };
    default:
      return { cause: "The host stopped while it was starting.", next: `Retry. ${AGAIN}` };
  }
}
