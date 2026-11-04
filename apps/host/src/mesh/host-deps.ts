import type { HostIdentity, SecureLink } from "@doriface/crypto";
import type { CreateSocket } from "@doriface/relay-client";
import type { LiveSessions } from "../e2ee/sessions.ts";
import type { PairingSlots } from "../pairing-slots.ts";
import type { MeshStore } from "../state/mesh.ts";
import { monotonicClock } from "./clock.ts";
import { MeshCommands } from "./commands.ts";
import type { MeshHooks } from "./host-hooks.ts";
import { HostMesh } from "./host-mesh.ts";
import { HostSync } from "./host-sync.ts";
import { meshProgram } from "./program.ts";
import { storedMeshStatus } from "./status-store.ts";
import { syncHooks } from "./sync-hooks.ts";

export interface MeshDepsOptions {
  readonly stateDir: string;
  readonly identity: HostIdentity;
  readonly mesh: MeshStore;
  readonly slots: PairingSlots;
  readonly sessions: LiveSessions;
  readonly hc: {
    readonly hc: string;
    readonly session?: string | undefined;
    readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  };
  readonly relay: { readonly url: string | undefined; readonly createSocket?: CreateSocket | undefined };
  /** The program mesh lines' `via` names; defaults to this executable or a launcher of this entry point. */
  readonly program?: string | undefined;
  /** The running mesh parts the commands and status reach; defaults to this host's own sync (`syncHooks`). */
  readonly hooks?: MeshHooks | undefined;
  readonly log: (line: string) => void;
}

/**
 * The running host's mesh: sync (section 5), joins and the mesh stream (section 4), and the commands and status the
 * control socket serves (sections 6 and 8.6), all over this host's one mesh.json.
 */
export function meshDeps(options: MeshDepsOptions) {
  const { stateDir, identity, mesh, slots, sessions, hc, relay, log } = options;
  const program = options.program ?? meshProgram(stateDir);
  const closeRevoked = (): void => sessions.closeRevoked();
  const openFrom = (noisePub: string): boolean => sessions.has(noisePub);
  const sync = new HostSync({ identity, mesh, relay, hc, stateDir, program, openFrom, closeRevoked, log });
  sync.changed();
  const hostMesh = new HostMesh({
    stateDir,
    identity,
    mesh,
    slots,
    sessions,
    hc,
    relay,
    sync: (s) => sync.adopt(s),
    floor: () => hooks.floor(),
    log,
  });
  const pending = () =>
    hostMesh.pending.list().map(({ nonce, name, hostId, noisePub, expiresAt }) => ({
      nonce,
      name,
      hostId,
      noisePub,
      expiresAt: new Date(expiresAt),
    }));
  const hooks = options.hooks ?? syncHooks(sync, monotonicClock, pending);
  return {
    hooks,
    hostMesh,
    sync,
    meshStream: (secure: SecureLink) => hostMesh.serve(secure),
    meshPresence: (secure: SecureLink) => sync.presence(secure),
    meshCommands: new MeshCommands({ store: mesh, stateDir, identity, closeRevoked, hooks, log }),
    meshStatus: () => storedMeshStatus(mesh, identity, hooks),
  };
}
