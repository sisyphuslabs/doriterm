import type { KeyValueStore } from "../storage/idb.ts";
import { memberCards } from "./bundle-view.ts";
import { resetBrowserIdentity } from "./identity.ts";
import { DEFAULT_SLOT, slotKeys } from "./identity-slots.ts";
import { changeRecord, readRecord } from "./mesh-record.ts";
import { type Enrollment, type MeshRecord, type SlotClaim, withMeshLock, writeRecord } from "./membership-list.ts";

export type RetiringClaim = Extract<SlotClaim, { readonly phase: "retiring" }>;

const taken = (record: MeshRecord, slot: string): boolean =>
  record.memberships.some((held) => held.keySlot === slot) || record.slots.some((claim) => claim.slot === slot);

/** A new enrollment on \`slot\` for \`owner\`, at a generation never handed out before. */
function enroll(record: MeshRecord, slot: string, owner: string) {
  const enrollment: Enrollment = { slot, owner, generation: record.next };
  const slots = [...record.slots, { ...enrollment, phase: "enrolling" as const }];
  return { next: { ...record, slots, next: record.next + 1 }, answer: enrollment };
}

/**
 * Claims a slot for one join before any key exists, under the mesh lock, so two joins at once (two tabs, an app and
 * its tab) never get the same identity. The first mesh takes the default identity, as a join always did; every other
 * join gets fresh keys. A slot name is random, so it says nothing about the mesh it will hold.
 */
export const claimSlot = (storage: KeyValueStore, owner: string): Promise<Enrollment> =>
  changeRecord(storage, (record) =>
    enroll(record, taken(record, DEFAULT_SLOT) ? crypto.randomUUID() : DEFAULT_SLOT, owner),
  );

/** Claims exactly \`slot\` when nothing holds it (a roster taking a paired browser in); undefined when something does. */
export const claimExact = (storage: KeyValueStore, slot: string, owner: string): Promise<Enrollment | undefined> =>
  changeRecord(storage, (record) =>
    taken(record, slot) ? { next: record, answer: undefined } : enroll(record, slot, owner),
  );

export type Resumed =
  | { readonly kind: "resumed"; readonly enrollment: Enrollment }
  | { readonly kind: "elsewhere" }
  | { readonly kind: "ended" };

/**
 * Takes over one saved join, for one owner only (review of #2890). The claim must still be at the generation the saved
 * join names: a join that was retired, abandoned or committed meanwhile is ended for good, never revived. Its owner moves
 * only when the one holding it is gone (\`live\` reads its Web Lock), so two tabs resuming the same join get one owner and
 * the other is told the join runs elsewhere; only the owner can commit (\`MembershipStore\`).
 */
export function resumeClaim(
  storage: KeyValueStore,
  slot: string,
  generation: number,
  owner: string,
  live: (owner: string) => Promise<boolean>,
): Promise<Resumed> {
  return withMeshLock(async () => {
    const record = await readRecord(storage);
    const claim = record.slots.find((held) => held.slot === slot && held.generation === generation);
    if (claim?.phase !== "enrolling") return { kind: "ended" };
    if (claim.owner !== owner && (await live(claim.owner))) return { kind: "elsewhere" };
    const slots = record.slots.map((held) => (held === claim ? { ...claim, owner } : held));
    await writeRecord(storage, { ...record, slots });
    return { kind: "resumed", enrollment: { slot, owner, generation } };
  });
}

/** Which lifecycle to retire: the one at \`generation\` (else whatever holds the slot), or only an unfinished join. */
export interface RetireTarget {
  readonly generation?: number;
  readonly claimOnly?: boolean;
}

/**
 * The first half of leaving a mesh or dropping a join, as one write under the lock: the membership or join goes and the
 * slot is marked retiring at that generation, with whether it was the last mesh decided in the same step. A join running
 * in another slot counts: while any other slot is enrolling the browser is not a stranger, so that join's keys and saved
 * join are not swept away mid-ceremony (review of #2890, LOW-5). Undefined when there is nothing to retire.
 */
export const beginRetire = (
  storage: KeyValueStore,
  slot: string,
  target: RetireTarget = {},
): Promise<RetiringClaim | undefined> =>
  changeRecord(storage, (record) => {
    const at = (generation: number): boolean => target.generation === undefined || generation === target.generation;
    const held =
      target.claimOnly === true ? undefined : record.memberships.find((m) => m.keySlot === slot && at(m.generation));
    const join = record.slots.find(
      (claim) => claim.slot === slot && claim.phase === "enrolling" && at(claim.generation),
    );
    const generation = held?.generation ?? join?.generation;
    if (generation === undefined) return { next: record, answer: undefined };
    const memberships = record.memberships.filter((membership) => membership !== held);
    const joining = record.slots.some((claim) => claim.slot !== slot && claim.phase === "enrolling");
    const hosts =
      held === undefined
        ? []
        : memberCards(held.records).flatMap((card) => (card.kind === "client" ? [] : [card.hostId]));
    const claim: RetiringClaim = {
      slot,
      phase: "retiring",
      generation,
      joined: held !== undefined,
      hosts,
      last: held !== undefined && memberships.length === 0 && !joining,
    };
    const slots = [...record.slots.filter((other) => other.slot !== slot), claim];
    return { next: { ...record, memberships, slots }, answer: claim };
  });

const stillRetiring = (record: MeshRecord, claim: RetiringClaim): boolean =>
  record.slots.some(
    (held) => held.slot === claim.slot && held.phase === "retiring" && held.generation === claim.generation,
  );

/**
 * The second half, safe to run again after a cut and safe to run late: every step acts only while the slot is still
 * retiring at the claim's generation, checked under the lock with the keys deleted in that same hold, so a cleanup run
 * after the slot was enrolled again never touches the new identity (review of #2890). Both keys of the slot and their
 * probes go (a join dropped on the default slot keeps its keys, which are also the pairing identity), then \`drop\` (a
 * saved push route, the last-mesh cleanup), then the claim.
 */
export async function finishRetire(
  storage: KeyValueStore,
  claim: RetiringClaim,
  drop: (claim: RetiringClaim) => Promise<void>,
): Promise<void> {
  const current = await withMeshLock(async () => {
    if (!stillRetiring(await readRecord(storage), claim)) return false;
    if (claim.joined || claim.slot !== DEFAULT_SLOT) await resetBrowserIdentity(slotKeys(storage, claim.slot));
    return true;
  });
  if (!current) return;
  await drop(claim);
  await changeRecord(storage, (record) => ({
    next: {
      ...record,
      slots: record.slots.filter(
        (held) => !(held.slot === claim.slot && held.phase === "retiring" && held.generation === claim.generation),
      ),
    },
    answer: undefined,
  }));
}
