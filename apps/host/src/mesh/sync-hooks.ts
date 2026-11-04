import type { Clock } from "./clock.ts";
import type { Gossip } from "./gossip.ts";
import type { MeshView } from "./mesh-view.ts";
import type { Reconciler } from "./reconciler.ts";
import type { MeshHooks } from "./host-hooks.ts";
import type { SyncFacts } from "./live-facts.ts";
import type { PendingJoinFact } from "./status-sources.ts";

/** The part of `HostSync` the mesh commands drive: its gossip and runtime once sync runs, starting it, stopping it. */
export interface SyncHandle {
  readonly gossip: Gossip | undefined;
  readonly runtime:
    | { readonly gossip: Pick<Gossip, "stop">; readonly reconciler: Pick<Reconciler, "reconcile" | "remaining"> }
    | undefined;
  changed(): void;
  stop(): void | Promise<void>;
  /** The running mesh's live facts. */
  live(): SyncFacts;
}

/** The view with no member: a reconcile against it removes every mesh machine from this host's core. */
const NO_MEMBERS: MeshView = { members: [], overCap: [], revoked: [] };

/** How often a confirmation wait looks at `owed()` again: confirmations arrive as the peers' next `hello`. */
const CONFIRM_STEP_MS = 250;

/**
 * The mesh commands' hooks on this host's sync (design 5.3 and 6.5). A record the store signed is pushed with
 * `gossip.stored`, which sends it on open sessions and dials every member still owed it. A member confirms once its
 * `hello` names heads that cover this host's records, which drops it out of `gossip.owed()`.
 */
export function syncHooks(sync: SyncHandle, clock: Clock, pending: () => readonly PendingJoinFact[]): MeshHooks {
  const wait = (ms: number): Promise<void> => new Promise((resolve) => void clock.after(ms, resolve));
  return {
    push(records) {
      const running = sync.gossip;
      if (running !== undefined) return running.stored(records);
      sync.changed();
      sync.gossip?.stored(records);
    },
    async confirmations(withinMs) {
      const gossip = sync.gossip;
      if (gossip === undefined) return [];
      const owed = (): ReadonlySet<string> => new Set(gossip.owed().map((member) => member.signPub));
      const expected = [...owed()];
      const deadline = clock.now() + withinMs;
      const untilConfirmed = async (): Promise<void> => {
        if (!expected.some((key) => owed().has(key)) || clock.now() >= deadline) return;
        await wait(Math.min(CONFIRM_STEP_MS, deadline - clock.now()));
        return untilConfirmed();
      };
      await untilConfirmed();
      const still = owed();
      return expected.filter((key) => !still.has(key));
    },
    async left() {
      const runtime = sync.runtime;
      try {
        if (runtime === undefined) return;
        runtime.gossip.stop();
        // The reconciler logs a failed run and resolves, so what is still in the core is read back.
        await runtime.reconciler.reconcile(NO_MEMBERS);
        const kept = await runtime.reconciler.remaining();
        if (kept.length > 0) throw new Error(`${kept.map((name) => JSON.stringify(name)).join(", ")} still in herdr`);
      } finally {
        await sync.stop();
      }
    },
    live: () => ({ ...sync.live(), pending: pending() }),
    floor: () => sync.gossip?.floor(),
  };
}
