import type { HostIdentity, SecureLink } from "@doriface/crypto";
import type { PlanPolicy } from "@doriface/policy";
import type { CreateSocket, RelayProofs } from "@doriface/relay-client";
import type { LiveSessions } from "../e2ee/sessions.ts";
import type { PairingSlots } from "../pairing-slots.ts";
import type { MeshStore } from "../state/mesh.ts";
import { monotonicClock } from "./clock.ts";
import { MeshCommands } from "./commands.ts";
import type { MeshHooks } from "./host-hooks.ts";
import type { PendingJoinFact } from "./status-sources.ts";
import { HostMesh } from "./host-mesh.ts";
import { HostSync } from "./host-sync.ts";
import type { HcTarget } from "./hc-machines.ts";
import { meshProgram } from "./program.ts";
import { storedMeshStatus } from "./status-store.ts";
import { syncHooks } from "./sync-hooks.ts";

export interface MeshDepsOptions {
  readonly stateDir: string;
  readonly identity: HostIdentity;
  readonly mesh: MeshStore;
  readonly slots: PairingSlots;
  readonly sessions: LiveSessions;
  /** The plan this host runs under: the mesh and its joins read it. */
  readonly policy: PlanPolicy;
  readonly hc: HcTarget;
  readonly relay: {
    readonly url: string | undefined;
    readonly createSocket?: CreateSocket | undefined;
    readonly proofs?: RelayProofs | undefined;
  };
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
    policy: options.policy,
    hc,
    relay,
    sync: (s) => sync.adopt(s),
    changed: () => sync.changed(),
    floor: () => hooks.floor(),
    formatReady: (records, view) => hooks.formatReady(records, view),
    log,
  });
  const pending = (): readonly PendingJoinFact[] =>
    hostMesh.pending.list().map(({ nonce, name, hostId, noisePub, expiresAt, kind, code, joinerConfirmed }) => ({
      nonce,
      name,
      hostId,
      noisePub,
      expiresAt: new Date(expiresAt),
      kind,
      code,
      joinerConfirmed,
    }));
  const hooks = options.hooks ?? syncHooks(sync, monotonicClock, pending);
  hostMesh.sweepRoster();
  return {
    hooks,
    hostMesh,
    resumeKey: (key: string) => hostMesh.resumeKey(key),
    removedRosterHeld: (key: string) => hostMesh.removedRosterHeld(key),
    sync,
    meshStream: (secure: SecureLink) => hostMesh.serve(secure),
    rosterStream: (secure: SecureLink) => hostMesh.roster(secure),
    meshPresence: (secure: SecureLink) => sync.presence(secure),
    meshCommands: new MeshCommands({ store: mesh, stateDir, identity, closeRevoked, hooks, log }),
    meshStatus: () => storedMeshStatus(mesh, identity, hooks),
    refreshMeshLines: () => hooks.refreshLines(),
  };
}
