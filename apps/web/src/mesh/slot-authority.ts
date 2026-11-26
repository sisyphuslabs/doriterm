import type { KeyValueStore } from "../storage/idb.ts";
import type { KeyCheck } from "../storage/key-authority.ts";
import { DEFAULT_SLOT, type MeshRecord, storedRecord } from "./membership-list.ts";

export class SlotNotEnrolled extends Error {
  override readonly name = "SlotNotEnrolled";
}

const refuse = (why: string): never => {
  throw new SlotNotEnrolled(why);
};

const retiring = (record: MeshRecord, slot: string): boolean =>
  record.slots.some((claim) => claim.slot === slot && claim.phase === "retiring");

/** Whether the slot is still at `generation`: its membership, or the enrollment that will become it. */
const atGeneration = (record: MeshRecord, slot: string, generation: number): boolean =>
  record.memberships.some((held) => held.keySlot === slot && held.generation === generation) ||
  record.slots.some((claim) => claim.slot === slot && claim.phase === "enrolling" && claim.generation === generation);

/**
 * The live authority over one slot's keys, read from storage itself and not from what a tab was told (review of #2890).
 * At load it fixes the generation the keys are loaded for: a membership's, a running join's, or none for the default
 * slot's pairing identity. Every later use (a signature, a Noise DH: dial, push, roster, vault, the service worker)
 * checks again that the slot is still at that generation, is not being retired and still has that key; a key held from
 * before, or an operation already running, is refused the moment its mesh is left or its join is retired or taken over.
 */
export async function slotAuthority(storage: KeyValueStore, keys: KeyValueStore, slot: string): Promise<KeyCheck> {
  const record = await storedRecord(storage);
  const generation =
    record.memberships.find((held) => held.keySlot === slot)?.generation ??
    record.slots.flatMap((claim) => (claim.slot === slot && claim.phase === "enrolling" ? [claim.generation] : []))[0];
  if (retiring(record, slot)) refuse("This mesh identity is being removed from this browser.");
  if (generation === undefined && slot !== DEFAULT_SLOT) refuse("This mesh identity is not enrolled on this browser.");
  return async (key) => {
    const now = await storedRecord(storage);
    if (retiring(now, slot)) refuse("This mesh identity is being removed from this browser.");
    if (generation !== undefined && !atGeneration(now, slot, generation)) {
      refuse("This mesh identity was left or replaced on this browser.");
    }
    if ((await keys.get(key)) == null) refuse("This identity's key was deleted on this browser.");
  };
}
