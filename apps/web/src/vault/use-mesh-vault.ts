import type { HcConnection } from "@doriface/client";
import { base64urlEncode } from "@doriface/crypto";
import { viewOf } from "@doriface/mesh";
import { type Keyholder, remoteKeyholder, VAULT_DOC } from "@doriface/vault";
import { useEffect, useSyncExternalStore } from "react";
import { connectionStore, useConnection } from "../connection/store.ts";
import { desktopKeyholderCall } from "../desktop/bridge.ts";
import { memberCards } from "../mesh/bundle-view.ts";
import { loadSignKey } from "../mesh/identity.ts";
import { membershipSnapshot } from "../mesh/membership-state.ts";
import { deviceStore } from "../storage/idb.ts";
import { callOver } from "./vault-channel.ts";
import { MeshVault, type MeshVaultSnapshot } from "./mesh-vault.ts";
import type { VaultReplica } from "./vault-sync.ts";

function openConnection(): HcConnection {
  const state = connectionStore.state;
  if (state.phase !== "open") throw new Error("Doriterm is not connected to a machine right now");
  return state.connection;
}

const replicaOn = (connection: HcConnection, on: string | null): VaultReplica => ({
  on,
  get: () => connection.call("doc.get", on === null ? { name: VAULT_DOC } : { name: VAULT_DOC, on }),
  set: (value, version) =>
    connection.call(
      "doc.set",
      on === null ? { name: VAULT_DOC, value, version } : { name: VAULT_DOC, on, value, version },
    ),
});

/** The connected core and every machine it has a live line to: each keeps its own copy of the vault document. */
async function replicas(): Promise<readonly VaultReplica[]> {
  const connection = openConnection();
  const { machines } = await connection.call("machine.list");
  const live = machines.filter((machine) => machine.state === "connected").map((machine) => machine.name);
  return [replicaOn(connection, null), ...live.map((name) => replicaOn(connection, name))];
}

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
  replicas,
  member: async () => {
    const view = membershipSnapshot();
    if (view.phase !== "joined") return undefined;
    const card = await loadSignKey();
    const signPub = base64urlEncode(card.publicKey);
    const members = new Set(memberCards(view.records).map((member) => member.signPub));
    const removed = viewOf(view.records).revoked;
    return { mesh: view.mesh, members, removed, self: { signPub, sign: (message) => card.sign(message) } };
  },
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
