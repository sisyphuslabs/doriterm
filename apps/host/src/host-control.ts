import type { MeshStatus } from "@doriface/protocol";
import { listenControl } from "./control.ts";
import type { e2eeDeps } from "./host-e2ee.ts";
import type { HostPush } from "./push/host-push.ts";
import { pendingToWire } from "./state/pairing.ts";

/** The control socket is how `devices revoke` closes live sessions, so a host that cannot open it does not start. */
export function openControl(
  stateDir: string,
  e2ee: ReturnType<typeof e2eeDeps>,
  meshStatus: (() => Promise<MeshStatus | undefined>) | undefined,
  push: HostPush | undefined,
) {
  return listenControl(stateDir, async (request, closed) => {
    switch (request.op) {
      case "devices-changed":
        push?.prune();
        return e2ee.sessions.closeRevoked();
      case "mesh-changed":
        e2ee.sync.changed();
        push?.prune();
        return e2ee.sessions.closeRevoked();
      case "pair":
        return pendingToWire(await e2ee.hostMesh.pairDevice());
      case "mesh-pair":
        return pendingToWire(await e2ee.hostMesh.pair(request.auto));
      case "mesh-pending":
        return e2ee.hostMesh.pending.next(closed);
      case "mesh-approve":
        return { decided: e2ee.hostMesh.pending.decide(request.nonce, request.approve) };
      case "mesh-join":
        return e2ee.hostMesh.join(request);
      case "mesh-status":
        return (await meshStatus?.()) ?? null;
      case "mesh-revoke":
        return e2ee.meshCommands.revoke(request);
      case "mesh-rename":
        return e2ee.meshCommands.rename(request);
      case "mesh-leave":
        return e2ee.meshCommands.leave();
    }
  });
}
