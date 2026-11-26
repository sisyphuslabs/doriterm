import type { HcConnection } from "@doriface/client";
import { viewOf } from "@doriface/mesh";
import { type MemberSigner, VAULT_DOC } from "@doriface/vault";
import type { ConnectionState } from "../connection/store.ts";
import { memberCards } from "../mesh/bundle-view.ts";
import type { MeshContext } from "../mesh/mesh-context.ts";
import type { VaultScope } from "./mesh-vault.ts";
import type { VaultReplica } from "./vault-sync.ts";

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
async function replicasOver(state: ConnectionState): Promise<readonly VaultReplica[]> {
  if (state.phase !== "open") throw new Error("Doriterm is not connected to a machine right now");
  const { connection } = state;
  const { machines } = await connection.call("machine.list");
  const live = machines.filter((machine) => machine.state === "connected").map((machine) => machine.name);
  return [replicaOn(connection, null), ...live.map((name) => replicaOn(connection, name))];
}

export interface ScopeDeps {
  /** The membership of the selected machine (`selectedContext`). */
  readonly context: () => MeshContext | undefined;
  /** The selected machine's connection, read in the same step as the context. */
  readonly connection: () => ConnectionState;
  readonly signer: (slot: string) => Promise<MemberSigner>;
}

/**
 * The vault's scope from ONE read of the selection: the slot that signs, the mesh, and the connection whose machines
 * receive the document all name the selected machine's membership. No selection that membership lists, no scope: the
 * vault stops rather than signing with one mesh's key for another (review of #2890).
 */
export async function vaultScope(deps: ScopeDeps): Promise<VaultScope | undefined> {
  const context = deps.context();
  if (context === undefined) return undefined;
  const state = deps.connection();
  const self = await deps.signer(context.slot);
  const { records, mesh } = context.view;
  return {
    member: {
      mesh,
      members: new Set(memberCards(records).map((member) => member.signPub)),
      removed: viewOf(records).revoked,
      self,
    },
    replicas: () => replicasOver(state),
  };
}
