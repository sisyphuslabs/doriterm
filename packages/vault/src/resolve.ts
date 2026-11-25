import { fromBase64, type PublicKey } from "typevault/core";
import type { VaultContext } from "./context.ts";
import type { VaultDoc } from "./doc.ts";
import { TIER, type TierHandle } from "./keyholder.ts";
import { type DeviceBody, readDevice, readTier, readWrap, recordId, type TierBody, type WrapBody } from "./records.ts";

export const TIER_MARK = `tier:${TIER}`;

export interface ResolvedTier {
  readonly id: string;
  readonly gen: number;
  readonly by: string;
  readonly publicKey: PublicKey;
}

export interface ResolvedVault {
  /** Announced vault keys of current members only. */
  readonly devices: ReadonlyMap<string, DeviceBody>;
  /** The current generation: the highest one a current member signed and this device has not seen superseded. */
  readonly tier: ResolvedTier | undefined;
  /** The highest generation a current member signed: a new generation must pass it. */
  readonly highestGen: number;
  /** A member signed a generation this device has already seen superseded: the copy is stale, not empty. */
  readonly stale: boolean;
}

export function resolveVault(doc: VaultDoc, ctx: VaultContext): ResolvedVault {
  const devices = new Map<string, DeviceBody>();
  for (const [signPub, record] of Object.entries(doc.devices)) {
    const body = readDevice(record, ctx.mesh);
    if (body !== undefined && body.signPub === signPub && ctx.members.has(signPub)) devices.set(signPub, body);
  }
  let tier: (TierBody & { readonly id: string }) | undefined;
  let highestGen = 0;
  let stale = false;
  for (const record of Object.values(doc.tiers)) {
    const body = readTier(record, ctx.mesh);
    if (body === undefined || !ctx.members.has(body.by)) continue;
    highestGen = Math.max(highestGen, body.gen);
    if (!ctx.ledger.allows(TIER_MARK, body.gen)) {
      stale = true;
      continue;
    }
    const id = recordId(record);
    if (tier === undefined || body.gen > tier.gen || (body.gen === tier.gen && id < tier.id)) tier = { ...body, id };
  }
  return {
    devices,
    highestGen,
    stale: stale && tier === undefined,
    tier:
      tier === undefined
        ? undefined
        : {
            id: tier.id,
            gen: tier.gen,
            by: tier.by,
            publicKey: { recipient: tier.recipient, signPublic: tier.signPublic },
          },
  };
}

export interface MemberWrap {
  readonly body: WrapBody;
  readonly wrap: string;
}

/** The tier's wraps that a current member signed, by holder; wraps nobody in the mesh vouches for are ignored. */
export function memberWraps(
  doc: VaultDoc,
  ctx: VaultContext,
  tierId: string,
): ReadonlyMap<string, readonly MemberWrap[]> {
  const out = new Map<string, MemberWrap[]>();
  for (const [holder, signers] of Object.entries(doc.wraps[tierId] ?? {})) {
    for (const [by, stored] of Object.entries(signers)) {
      if (!ctx.members.has(by)) continue;
      const body = readWrap(stored, ctx.mesh, { tier: tierId, holder, by });
      if (body !== undefined) out.set(holder, [...(out.get(holder) ?? []), { body, wrap: stored.wrap }]);
    }
  }
  return out;
}

/** Members whose announced key has a wrap of the current tier signed by a current member: the devices that can open it. */
export function openersOf(doc: VaultDoc, ctx: VaultContext, resolved: ResolvedVault): ReadonlySet<string> {
  if (resolved.tier === undefined) return new Set();
  const wraps = memberWraps(doc, ctx, resolved.tier.id);
  return new Set(
    [...resolved.devices].flatMap(([holder, device]) =>
      (wraps.get(holder) ?? []).some((item) => item.body.recipient === device.recipient) ? [holder] : [],
    ),
  );
}

/** Opens this device's wrap of the current tier inside the keyholder: undefined when none is the signed tier key. */
export async function unlockTier(
  doc: VaultDoc,
  ctx: VaultContext,
  tier: ResolvedTier,
): Promise<TierHandle | undefined> {
  for (const { wrap } of memberWraps(doc, ctx, tier.id).get(ctx.self.signPub) ?? []) {
    // oxlint-disable-next-line no-await-in-loop -- tried in turn: the first wrap that opens is enough
    const handle = await ctx.key.unwrap(fromBase64(wrap), tier.gen, tier.publicKey);
    if (handle !== undefined) {
      ctx.ledger.accept(TIER_MARK, tier.gen);
      return handle;
    }
  }
  return undefined;
}
