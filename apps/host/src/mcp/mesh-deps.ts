import type { MeshStatus } from "@doriface/protocol";
import type { DeviceSurface } from "../device-surface.ts";
import type { e2eeDeps } from "../host-e2ee.ts";
import { pairingOfferView } from "../pair-offer.ts";
import type { MeshToolDeps } from "./mesh-tools.ts";

export interface MeshToolParts {
  readonly e2ee: ReturnType<typeof e2eeDeps>;
  readonly devices: DeviceSurface;
  /** The mesh status the control socket answers `mesh status` with. */
  readonly status: () => Promise<MeshStatus | undefined>;
  readonly relayUrl: string;
}

/** The mesh tools' reach into the running host: each entry is the call the control socket makes for the same act. */
export function meshToolDeps({ e2ee, devices, status, relayUrl }: MeshToolParts): MeshToolDeps {
  const { hostMesh, meshCommands, identity } = e2ee;
  return {
    status,
    pending: () => hostMesh.pending.list(),
    devices: () => devices.list(),
    invite: async (mesh) => {
      const offer = await (mesh ? hostMesh.pair(false) : hostMesh.pairDevice());
      return pairingOfferView({ identity, offer, relayUrl });
    },
    decide: (nonce, approve, code) => hostMesh.pending.decide(nonce, approve, code),
    revokeDevice: (id) => devices.revoke(id),
    revoke: (request) => meshCommands.revoke(request),
    rename: (request) => meshCommands.rename(request),
    leavePreview: () => meshCommands.leavePreview(),
    leave: (expect) => meshCommands.leave(expect),
  };
}
