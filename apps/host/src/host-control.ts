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
  /** Writes the host's facts again after `skill install` or `skill uninstall` changed the skill on this machine. */
  skillChanged?: () => void,
  /** Starts the host's writers on its core once it is in a mesh, whose reconciler brings the core up. */
  meshJoined?: () => void,
) {
  return listenControl(stateDir, async (request, closed, confirm) => {
    switch (request.op) {
      case "devices-changed":
        e2ee.hostMesh.sweepRoster();
        push?.prune();
        return e2ee.sessions.closeRevoked();
      case "mesh-changed":
        e2ee.sync.changed();
        meshJoined?.();
        push?.prune();
        return e2ee.sessions.closeRevoked();
      case "pair":
        return pendingToWire(await e2ee.hostMesh.pairDevice());
      case "mesh-pair":
        return pendingToWire(await e2ee.hostMesh.pair(request.auto));
      case "mesh-pending":
        return e2ee.hostMesh.pending.next(closed);
      case "mesh-approve":
        return { decided: e2ee.hostMesh.pending.decide(request.nonce, request.approve, request.code) };
      case "mesh-join": {
        const joined = await e2ee.hostMesh.join(request, confirm);
        meshJoined?.();
        return joined;
      }
      case "mesh-status":
        return (await meshStatus?.()) ?? null;
      case "mesh-revoke":
        return e2ee.meshCommands.revoke(request);
      case "mesh-rename":
        return e2ee.meshCommands.rename(request);
      case "skill-changed":
        skillChanged?.();
        return { refreshed: skillChanged !== undefined };
      case "mesh-leave":
        return request.preview === true ? e2ee.meshCommands.leavePreview() : e2ee.meshCommands.leave(request.expect);
    }
  });
}

/**
 * The control socket of a host that keeps state, or none for a host without one. Its mesh status is read after the
 * mesh lines are refreshed, as the published one is (#754); a socket that cannot open stops the start.
 */
export function openHostControl(
  stateDir: string | undefined,
  e2ee: ReturnType<typeof e2eeDeps> | undefined,
  meshStatus: (() => MeshStatus | undefined) | undefined,
  refreshMeshLines: () => Promise<void>,
  push: HostPush | undefined,
  writers: { readonly skillChanged?: (() => void) | undefined; readonly startIfInMesh: () => void },
): ReturnType<typeof openControl> | undefined {
  if (stateDir === undefined || e2ee === undefined) return undefined;
  const status =
    meshStatus === undefined
      ? undefined
      : async () => {
          await refreshMeshLines();
          return meshStatus();
        };
  try {
    return openControl(stateDir, e2ee, status, push, writers.skillChanged, writers.startIfInMesh);
  } catch (error) {
    throw new Error(`cannot open the control socket that devices revoke uses: ${String(error)}`, { cause: error });
  }
}
