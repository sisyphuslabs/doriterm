import {
  decodeSecretKey,
  fromBase64,
  fromUtf8,
  type PublicKey,
  publicKeyOf,
  samePublic,
  type SecretKey,
  TypeVaultError,
  type VaultState,
} from "typevault/core";
import type { VaultContext } from "./context.ts";
import type { VaultDoc } from "./doc.ts";
import { type DeviceBody, readDevice, readTier, recordId, type TierBody } from "./records.ts";

export const TIER = "mesh";
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
  /** The highest generation any record names, trusted or not: a new generation must pass it. */
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
    if (body === undefined) continue;
    highestGen = Math.max(highestGen, body.gen);
    if (!ctx.members.has(body.by)) continue;
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

/** The TypeVault state an envelope is checked against: one tier, whose key also stands in as the owner key. */
export const stateOf = (tier: ResolvedTier): VaultState => ({
  owner: tier.publicKey,
  origin: tier.id,
  handovers: [],
  seqs: { tiers: tier.gen, members: 1, signers: 1, ceilings: 1 },
  tiers: { [TIER]: { includes: [], gen: tier.gen, ...tier.publicKey } },
  members: {},
  signers: {},
  ceilings: {},
});

/** Opens this device's wrap of the current tier key: undefined when there is none or it is not the signed tier key. */
export async function unlockTier(doc: VaultDoc, ctx: VaultContext, tier: ResolvedTier): Promise<SecretKey | undefined> {
  const wrap = doc.wraps[tier.id]?.[ctx.self.signPub];
  if (wrap === undefined) return undefined;
  let bytes: Uint8Array;
  try {
    bytes = await ctx.key.unseal(fromBase64(wrap));
  } catch (cause) {
    if (cause instanceof TypeVaultError) return undefined;
    throw cause;
  }
  let key: SecretKey;
  try {
    key = decodeSecretKey(fromUtf8(bytes));
  } catch (cause) {
    if (cause instanceof TypeVaultError) return undefined;
    throw cause;
  }
  const { role } = key;
  if (role.kind !== "tier" || role.tier !== TIER || role.gen !== tier.gen) return undefined;
  if (!samePublic(await publicKeyOf(key), tier.publicKey)) return undefined;
  ctx.ledger.accept(TIER_MARK, tier.gen);
  return key;
}
