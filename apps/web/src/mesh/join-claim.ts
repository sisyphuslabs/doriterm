import { JoinRefused } from "@doriface/mesh/join";
import { deviceStore, type KeyValueStore } from "../storage/idb.ts";
import { claimSlot, resumeClaim } from "./enrollment.ts";
import { enrollLock, holdLock, liveJoin } from "./join-locks.ts";
import { currentRecord } from "./mesh-record.ts";
import type { Enrollment } from "./membership-list.ts";
import type { MembershipStore } from "./membership.ts";
import { retireSlot } from "./membership-lifecycle.ts";

export interface Join {
  readonly enrollment: Enrollment;
  readonly end: () => void;
}

/** The saved join a resume continues: its slot and the generation it was claimed at. */
export interface SavedJoin {
  readonly slot: string;
  readonly generation: number | undefined;
}

/**
 * One join's enrollment, made before any key exists and held for the join's life: the owner's lock is taken first, so
 * there is no moment when the claim exists and a sweep in another tab could take it for an abandoned one. A resume takes
 * the saved join over only at its own generation and only from an owner that is gone (`resumeClaim`); a saved join that
 * names no generation, or one retired meanwhile, is ended for good (review of #2890).
 */
export async function beginJoin(resume?: SavedJoin, storage: KeyValueStore = deviceStore): Promise<Join> {
  const owner = crypto.randomUUID();
  const end = await holdLock(enrollLock(owner));
  try {
    if (resume === undefined) return { enrollment: await claimSlot(storage, owner), end };
    const resumed =
      resume.generation === undefined
        ? ({ kind: "ended" } as const)
        : await resumeClaim(storage, resume.slot, resume.generation, owner, liveJoin);
    if (resumed.kind === "resumed") return { enrollment: resumed.enrollment, end };
    throw new JoinRefused(resumed.kind === "elsewhere" ? "This join is open in another tab." : "Ask for a new invite");
  } catch (error) {
    end();
    throw error;
  }
}

/**
 * A join that ended without a membership leaves no keys in its own slot: they were shown to that inviter only. Only the
 * join's own unfinished claim is retired, at its generation, so a join committed meanwhile is never undone by it.
 */
export async function abandonJoin(enrollment: Enrollment, storage: KeyValueStore = deviceStore): Promise<void> {
  await retireSlot(enrollment.slot, storage, { generation: enrollment.generation, claimOnly: true });
}

/**
 * A roster that would take this browser in on a slot that holds no mesh enrolls through a claim like any join, so the
 * same rules hold for it; undefined when another join or mesh holds the slot. The returned function ends it, dropping
 * the claim when no membership came of it.
 */
export async function enrollFor(bundle: MembershipStore): Promise<(() => Promise<void>) | undefined> {
  const owner = crypto.randomUUID();
  const end = await holdLock(enrollLock(owner));
  const enrollment = await bundle.enroll(owner).catch(() => undefined);
  if (enrollment === undefined) {
    end();
    return undefined;
  }
  return async () => {
    end();
    const record = await currentRecord(deviceStore);
    if (!record.memberships.some((held) => held.keySlot === enrollment.slot)) await abandonJoin(enrollment);
  };
}
