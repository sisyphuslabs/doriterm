import { isSameOrigin } from "../config/origin.ts";
import type { IpcSender } from "./ipc-handlers.ts";
import type { DesktopVaultKey } from "./vault-key.ts";

export interface VaultDeps {
  readonly origin: string;
  /** Opened once per launch, on first use; a rejection (no key store, a foreign key file) reaches the page as an error. */
  readonly key: () => Promise<DesktopVaultKey>;
}

export interface VaultHandlers {
  recipient(event: IpcSender): Promise<string>;
  protection(event: IpcSender): Promise<string>;
  unseal(event: IpcSender, candidate: unknown): Promise<Uint8Array>;
}

function assertAppFrame(event: IpcSender, origin: string): void {
  const url = event.senderFrame?.url ?? "";
  if (!isSameOrigin(url, origin)) throw new Error(`refused IPC from ${url === "" ? "a detached frame" : url}`);
}

/** A sealed wrap is a few hundred bytes; anything far larger is not one. */
const MAX_SEALED = 64 * 1024;

/**
 * The vault key's three uses, for the app's own page only: its age recipient, how it is protected, and opening a wrap
 * sealed to it. The identity itself never crosses to the page, as a browser's non-extractable key never reaches script.
 */
export function vaultHandlers(deps: VaultDeps): VaultHandlers {
  return {
    async recipient(event) {
      assertAppFrame(event, deps.origin);
      return (await deps.key()).recipient;
    },
    async protection(event) {
      assertAppFrame(event, deps.origin);
      return (await deps.key()).protection;
    },
    async unseal(event, candidate) {
      assertAppFrame(event, deps.origin);
      if (!(candidate instanceof Uint8Array) || candidate.length > MAX_SEALED)
        throw new Error("not a sealed vault wrap");
      return (await deps.key()).unseal(candidate);
    },
  };
}
