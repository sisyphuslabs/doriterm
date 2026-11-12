import { writeFileSync } from "node:fs";
import { hcOn } from "./machine-switch.ts";

/** hc's answer to `get` for a terminal on one core: "live", "finished", or "gone" once it is removed. */
export function stateOn(core: "host" | "machine", address: string): string {
  try {
    const got: unknown = JSON.parse(hcOn(core, ["get", address, "--json"]));
    const state = typeof got === "object" && got !== null ? Reflect.get(got, "state") : undefined;
    return typeof state === "string" ? state : "unknown";
  } catch {
    return "gone";
  }
}

/**
 * Removes the terminal, so no later spec counts it; `go` is the file a program started with {@link waitFor} waits for,
 * created first so that program ends. A plain shell has no such file and passes none.
 */
export function removeTerminal(core: "host" | "machine", address: string, go?: string): void {
  if (go !== undefined) writeFileSync(go, "");
  if (stateOn(core, address) === "gone") return;
  if (stateOn(core, address) === "live") hcOn(core, ["kill", address]);
  hcOn(core, ["rm", address]);
}

/** A shell line that ends the program only once the test creates `go`, so it ends while its view is not mounted. */
export const waitFor = (go: string) => `echo armed-$((3*3)); until [ -e '${go}' ]; do sleep 0.1; done; exit`;
