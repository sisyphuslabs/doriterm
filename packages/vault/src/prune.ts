import type { VaultContext } from "./context.ts";
import type { VaultDoc } from "./doc.ts";
import { readTier } from "./records.ts";
import type { ResolvedTier } from "./resolve.ts";

type Nested<T> = Readonly<Record<string, Readonly<Record<string, T>>>>;

const without = <T>(record: Readonly<Record<string, T>>, drop: ReadonlySet<string>) =>
  Object.fromEntries(Object.entries(record).filter(([key]) => !drop.has(key)));

function dropTiers(doc: VaultDoc, tiers: ReadonlySet<string>): VaultDoc {
  if (tiers.size === 0) return doc;
  const entries = Object.fromEntries(
    Object.entries(doc.entries).flatMap(([id, byTier]) => {
      const kept = without(byTier, tiers);
      return Object.keys(kept).length === 0 ? [] : [[id, kept] as const];
    }),
  );
  return { ...doc, tiers: without(doc.tiers, tiers), wraps: without(doc.wraps, tiers), entries };
}

/** Generations older than the current one, with their wraps and entries: the ledger refuses them anyway. */
export function pruneOlder(doc: VaultDoc, tier: ResolvedTier, ctx: VaultContext): VaultDoc {
  const older = Object.entries(doc.tiers).flatMap(([id, record]) => {
    const gen = readTier(record, ctx.mesh)?.gen ?? 0;
    return gen < tier.gen && id !== tier.id ? [id] : [];
  });
  return dropTiers(doc, new Set(older));
}

/** How long an unknown signer's items are kept: long enough for every device's mesh records to learn a new member. */
export const STRANGER_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

function withoutSigners<T>(wraps: Nested<Readonly<Record<string, T>>>, drop: (signPub: string) => boolean) {
  return Object.fromEntries(
    Object.entries(wraps).map(([tier, holders]) => [
      tier,
      Object.fromEntries(
        Object.entries(holders).flatMap(([holder, signers]) => {
          const kept = Object.fromEntries(Object.entries(signers).filter(([by]) => !drop(by)));
          return Object.keys(kept).length === 0 ? [] : [[holder, kept] as const];
        }),
      ),
    ]),
  );
}

/**
 * What only keys outside the mesh produced: announcements, tier records (with that generation's wraps and entries)
 * and wraps signed by them. Merging keeps such items by signature alone, so a writer minting fresh keys could grow the
 * document without bound. A member removed by the verified mesh records is pruned at once. A signer this device simply
 * does not know is kept for STRANGER_GRACE_MS from when this device first saw it: its own mesh records may lag behind a
 * member that just joined, and deleting that member's generation would destroy its entries on every machine. Wraps a
 * member signed stay whoever holds them: they are the evidence that a removed device saw a key.
 */
export function pruneOutsiders(doc: VaultDoc, ctx: VaultContext): VaultDoc {
  const now = Date.parse(ctx.now());
  const drop = (signPub: string): boolean => {
    if (ctx.members.has(signPub)) return false;
    if (ctx.removed.has(signPub)) return true;
    return now - Date.parse(ctx.strangers.firstSeen(signPub, ctx.now())) > STRANGER_GRACE_MS;
  };
  const outsideTiers = Object.entries(doc.tiers).flatMap(([id, record]) => {
    const by = readTier(record, ctx.mesh)?.by;
    return by !== undefined && drop(by) ? [id] : [];
  });
  const pruned = dropTiers(doc, new Set(outsideTiers));
  return {
    ...pruned,
    devices: Object.fromEntries(Object.entries(pruned.devices).filter(([signPub]) => !drop(signPub))),
    wraps: withoutSigners(pruned.wraps, drop),
  };
}
