import { isSameOrigin } from "../config/origin.ts";
import type { IpcSender } from "./ipc-handlers.ts";

export interface VaultDeps {
  readonly origin: string;
  /**
   * The keyholder's served side (`serveKeyholder` over this computer's vault key), opened once per launch on first use;
   * a rejection (no key store, a foreign key file) reaches the page as an error.
   */
  readonly serve: () => Promise<(request: unknown) => Promise<unknown>>;
}

export interface VaultHandlers {
  keyholder(event: IpcSender, request: unknown): Promise<unknown>;
}

function assertAppFrame(event: IpcSender, origin: string): void {
  const url = event.senderFrame?.url ?? "";
  if (!isSameOrigin(url, origin)) throw new Error(`refused IPC from ${url === "" ? "a detached frame" : url}`);
}

/**
 * The vault keyholder for the app's own page only. The page asks it to open, seal and wrap with tier keys this process
 * holds; no answer carries key bytes. Script in the app origin can still have a key wrapped to a recipient of its own;
 * #2828 moves recipient choice here so it cannot.
 */
export function vaultHandlers(deps: VaultDeps): VaultHandlers {
  return {
    async keyholder(event, request) {
      assertAppFrame(event, deps.origin);
      return (await deps.serve())(request);
    },
  };
}
