import { base64urlEncode } from "@doriface/crypto";
import { type Keyholder, remoteKeyholder } from "@doriface/vault";
import { useEffect, useSyncExternalStore } from "react";
import { connectionStore, useConnection } from "../connection/store.ts";
import { desktopKeyholderCall } from "../desktop/bridge.ts";
import { loadSignKey } from "../mesh/identity.ts";
import { slotKeys } from "../mesh/identity-slots.ts";
import { selectedContext } from "../mesh/membership-state.ts";
import { deviceStore } from "../storage/idb.ts";
import { callOver } from "./vault-channel.ts";
import { MeshVault, type MeshVaultSnapshot } from "./mesh-vault.ts";
import { vaultScope } from "./vault-scope.ts";

/**
 * Where this device's tier keys are held: the desktop app's main process, else a worker of this page. Either way the
 * page gets handles that use a key, never the key.
 */
function openKeyholder(): Promise<Keyholder> {
  const desktop = desktopKeyholderCall();
  if (desktop !== null) return remoteKeyholder(desktop);
  const worker = new Worker(new URL("./vault-worker.ts", import.meta.url), { type: "module", name: "vault" });
  return remoteKeyholder(callOver(worker));
}

let keyholder: Promise<Keyholder> | undefined;

export const meshVault = new MeshVault({
  scope: () =>
    vaultScope({
      context: selectedContext,
      connection: () => connectionStore.state,
      signer: async (slot) => {
        const card = await loadSignKey(slotKeys(deviceStore, slot));
        return { signPub: base64urlEncode(card.publicKey), sign: (message) => card.sign(message) };
      },
    }),
  key: () => {
    keyholder ??= openKeyholder();
    keyholder.catch(() => {
      keyholder = undefined;
    });
    return keyholder;
  },
  storage: deviceStore,
  now: () => new Date().toISOString(),
});

/** The mesh vault as Settings shows it; syncs whenever this page's connection opens. */
export function useMeshVault(): MeshVaultSnapshot {
  const connection = useConnection();
  const open = connection.phase === "open" ? connection.connection : null;
  useEffect(() => {
    void (open === null ? meshVault.offline() : meshVault.sync());
  }, [open]);
  return useSyncExternalStore(meshVault.subscribe, () => meshVault.snapshot);
}
