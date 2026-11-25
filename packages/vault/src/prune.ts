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

function withoutSigners<T>(wraps: Nested<Readonly<Record<string, T>>>, members: ReadonlySet<string>) {
  return Object.fromEntries(
    Object.entries(wraps).map(([tier, holders]) => [
      tier,
      Object.fromEntries(
        Object.entries(holders).flatMap(([holder, signers]) => {
          const kept = Object.fromEntries(Object.entries(signers).filter(([by]) => members.has(by)));
          return Object.keys(kept).length === 0 ? [] : [[holder, kept] as const];
        }),
      ),
    ]),
  );
}

/**
 * What only keys outside this device's member set produced: announcements of non-members, tier records they signed
 * (with that generation's wraps and entries), and wraps they signed. Merging keeps such items by signature alone, so
 * a writer minting fresh keys could grow the document without bound; a member's upkeep removes them. Wraps a member
 * signed stay whoever holds them: they are the evidence that a removed device saw a key.
 */
export function pruneOutsiders(doc: VaultDoc, ctx: VaultContext): VaultDoc {
  const outsideTiers = Object.entries(doc.tiers).flatMap(([id, record]) => {
    const by = readTier(record, ctx.mesh)?.by;
    return by === undefined || !ctx.members.has(by) ? [id] : [];
  });
  const pruned = dropTiers(doc, new Set(outsideTiers));
  return {
    ...pruned,
    devices: Object.fromEntries(Object.entries(pruned.devices).filter(([signPub]) => ctx.members.has(signPub))),
    wraps: withoutSigners(pruned.wraps, ctx.members),
  };
}
