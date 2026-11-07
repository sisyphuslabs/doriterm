import type { Signed } from "@doriface/mesh";
import type { CounterFloor } from "./merge.ts";
import type { BudgetFacts, LineFacts, PeerFacts, PendingJoinFact } from "./status-sources.ts";

/** The live facts of `mesh status` that only the running parts of the mesh hold (design sections 8.2 and 8.6). */
export interface MeshLiveFacts {
  readonly pending: readonly PendingJoinFact[];
  readonly peers: ReadonlyMap<string, PeerFacts>;
  readonly lines: ReadonlyMap<string, LineFacts>;
  readonly budget: BudgetFacts;
  readonly possiblyRevoked: boolean;
  /** The highest counter of this host's key a standing claim holds (section 10.1), 0 when none stands. */
  readonly peerCounter: number;
}

/**
 * The running parts of the mesh that the commands and the status reach through the host: joins (PR 4), sync and the
 * dial policy (PR 5), and the reconciler with its lines (PR 6). The host builds them from its sync (`syncHooks`);
 * `IDLE_MESH_HOOKS` reaches no member.
 */
export interface MeshHooks {
  /** Pushes records this host signed through its store to every member owed them (section 5.3). */
  push(records: readonly Signed[]): void;
  /** Within `withinMs`, the signPubs of the members owed this host's records that confirmed them (section 6.5). */
  confirmations(withinMs: number): Promise<readonly string[]>;
  /** After `mesh leave` deleted mesh.json: removes this host's mesh machines (section 6.5). */
  left(): Promise<void>;
  live(): MeshLiveFacts;
  /** Reads herdr's machine list again before a status read, bounded, so `live()` names each line as herdr does (#754). */
  refreshLines(): Promise<void>;
  /** The highest claim a peer's `hello` holds on this host's counter: the commands sign nothing below it (10.1). */
  floor(): CounterFloor | undefined;
  /**
   * Whether every member reads the format a client admission is written in. False while any member has not said so, which
   * is why the gate is asked before the record is signed and not after (design of #942).
   */
  formatReady(): boolean;
}

export const IDLE_MESH_HOOKS: MeshHooks = {
  push: () => undefined,
  confirmations: () => Promise.resolve([]),
  left: () => Promise.resolve(),
  floor: () => undefined,
  formatReady: () => false,
  refreshLines: () => Promise.resolve(),
  live: () => ({
    pending: [],
    peers: new Map(),
    lines: new Map(),
    budget: { waiting: 0, halvedUntil: null },
    possiblyRevoked: false,
    peerCounter: 0,
  }),
};
