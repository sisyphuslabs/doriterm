import { bytesToHex } from "@noble/hashes/utils.js";
import {
  type Envelope,
  type EntryPayload,
  type Field,
  generateSecretKey,
  openEntry,
  parseEntryName,
  publicKeyOf,
  type SecretKey,
  sealEntry,
  sealWrap,
  signerOf,
  toBase64,
  TypeVaultError,
  verifyEnvelope,
} from "typevault/core";
import type { VaultContext } from "./context.ts";
import type { VaultDoc } from "./doc.ts";
import { readDevice, recordId, signRecord } from "./records.ts";
import {
  type ResolvedTier,
  type ResolvedVault,
  resolveVault,
  stateOf,
  TIER,
  TIER_MARK,
  unlockTier,
} from "./resolve.ts";

export { resolveVault } from "./resolve.ts";

export type EntryRead =
  | { readonly kind: "open"; readonly id: string; readonly rev: number; readonly payload: EntryPayload }
  /** Entries exist, but this device holds no key to the current generation yet. */
  | { readonly kind: "locked" }
  | { readonly kind: "missing" }
  /** The copy handed over is older than one this device has already seen. */
  | { readonly kind: "rolled-back" };

const entryMark = (id: string): string => `entry:${id}`;

/** Every entry of the current generation that verifies and opens, with its payload. */
async function openAll(doc: VaultDoc, tier: ResolvedTier, key: SecretKey) {
  const state = stateOf(tier);
  const unlock = async (name: string) => (name === TIER ? key : undefined);
  const current = Object.values(doc.entries).filter(
    (envelope) => envelope.tier === TIER && envelope.gen === tier.gen && verifyEnvelope(envelope, state) === undefined,
  );
  const opened = await Promise.all(
    current.map(async (envelope) => ({
      envelope,
      // One signed entry that cannot be read (bad payload) must not take every other entry down with it.
      payload: await openEntry(envelope, { unlock }).catch((cause: unknown) => {
        if (cause instanceof TypeVaultError) return undefined;
        throw cause;
      }),
    })),
  );
  return opened.filter(
    (item): item is { readonly envelope: Envelope; readonly payload: EntryPayload } => item.payload !== undefined,
  );
}

export async function readEntry(doc: VaultDoc, ctx: VaultContext, name: string): Promise<EntryRead> {
  const { tier } = resolveVault(doc, ctx);
  if (tier === undefined) return { kind: "missing" };
  const key = await unlockTier(doc, ctx, tier);
  if (key === undefined) return Object.keys(doc.entries).length > 0 ? { kind: "locked" } : { kind: "missing" };
  const match = (await openAll(doc, tier, key)).find((item) => item.payload.name === name);
  if (match === undefined) return { kind: "missing" };
  const { id, rev } = match.envelope;
  if (!ctx.ledger.accept(entryMark(id), rev)) return { kind: "rolled-back" };
  return { kind: "open", id, rev, payload: match.payload };
}

const newEntryId = (): string => `${TIER}.${bytesToHex(crypto.getRandomValues(new Uint8Array(16)))}`;

export async function writeEntry(
  doc: VaultDoc,
  ctx: VaultContext,
  name: string,
  fields: Readonly<Record<string, Field>>,
): Promise<VaultDoc> {
  const { tier } = resolveVault(doc, ctx);
  const key = tier === undefined ? undefined : await unlockTier(doc, ctx, tier);
  if (tier === undefined || key === undefined)
    throw new TypeVaultError("denied", "the mesh vault is locked on this device");
  const existing = (await openAll(doc, tier, key)).find((item) => item.payload.name === name);
  const at = ctx.now();
  const id = existing?.envelope.id ?? newEntryId();
  const rev = (existing?.envelope.rev ?? 0) + 1;
  const payload: EntryPayload = {
    v: 1,
    name: parseEntryName(name),
    fields,
    tags: [],
    created: existing?.payload.created ?? at,
    rotated: at,
  };
  const envelope = await sealEntry({ id, tier: TIER, rev, at, payload }, stateOf(tier), signerOf(key));
  ctx.ledger.accept(entryMark(id), rev);
  return { ...doc, entries: { ...doc.entries, [id]: envelope } };
}

async function announce(doc: VaultDoc, ctx: VaultContext): Promise<VaultDoc> {
  const held = doc.devices[ctx.self.signPub];
  const current = held === undefined ? undefined : readDevice(held, ctx.mesh);
  if (current?.recipient === ctx.key.recipient && current.protection === ctx.key.protection) return doc;
  const record = await signRecord(
    {
      v: 1,
      type: "vault-device",
      mesh: ctx.mesh,
      signPub: ctx.self.signPub,
      recipient: ctx.key.recipient,
      protection: ctx.key.protection,
      at: ctx.now(),
    },
    ctx.self,
  );
  return { ...doc, devices: { ...doc.devices, [ctx.self.signPub]: record } };
}

async function wrapsFor(key: SecretKey, devices: ResolvedVault["devices"]): Promise<Record<string, string>> {
  const sealed = await Promise.all(
    [...devices].map(
      async ([signPub, device]) => [signPub, toBase64(await sealWrap(key, [device.recipient]))] as const,
    ),
  );
  return Object.fromEntries(sealed);
}

/**
 * A new generation wrapped to current members only, carrying `carried` entries re-encrypted under it. Everything of
 * older generations is dropped from the document: the ledger refuses them anyway once the new generation is seen.
 */
async function newGeneration(
  doc: VaultDoc,
  ctx: VaultContext,
  resolved: ResolvedVault,
  carried: readonly { readonly envelope: Envelope; readonly payload: EntryPayload }[],
): Promise<VaultDoc> {
  const gen = Math.max(resolved.highestGen, resolved.tier?.gen ?? 0) + 1;
  const key = await generateSecretKey({ kind: "tier", tier: TIER, gen });
  const publicKey = await publicKeyOf(key);
  const record = await signRecord(
    { v: 1, type: "vault-tier", mesh: ctx.mesh, tier: TIER, gen, ...publicKey, by: ctx.self.signPub, at: ctx.now() },
    ctx.self,
  );
  const tier: ResolvedTier = { id: recordId(record), gen, by: ctx.self.signPub, publicKey };
  const resealed = await Promise.all(
    carried.map(async ({ envelope, payload }) => {
      const flagged = Object.values(payload.fields).some((field) => field.type === "secret");
      const next = { ...payload, ...(flagged ? { needsRotation: true } : {}) };
      const draft = { id: envelope.id, tier: TIER, rev: envelope.rev + 1, at: ctx.now(), payload: next };
      return sealEntry(draft, stateOf(tier), signerOf(key));
    }),
  );
  for (const envelope of resealed) ctx.ledger.accept(entryMark(envelope.id), envelope.rev);
  const entries: Record<string, Envelope> = Object.fromEntries(resealed.map((envelope) => [envelope.id, envelope]));
  ctx.ledger.accept(TIER_MARK, gen);
  return {
    ...doc,
    tiers: { [tier.id]: record },
    wraps: { [tier.id]: await wrapsFor(key, resolved.devices) },
    entries,
  };
}

/**
 * One device's share of keeping the vault: announce this device's key; start a generation when there is no trusted
 * one (but never over a stale copy: that waits for a fresher machine); with the current key in hand, rotate when a non-member holds a wrap of it (a revoked device saw it), and
 * otherwise wrap it to every announced member that has none yet. A device without the key only announces itself.
 */
export async function maintain(doc: VaultDoc, ctx: VaultContext): Promise<VaultDoc> {
  if (!ctx.members.has(ctx.self.signPub)) return doc;
  const announced = await announce(doc, ctx);
  const resolved = resolveVault(announced, ctx);
  const { tier } = resolved;
  if (tier === undefined) return resolved.stale ? announced : newGeneration(announced, ctx, resolved, []);
  const key = await unlockTier(announced, ctx, tier);
  if (key === undefined) return announced;
  const holders = Object.keys(announced.wraps[tier.id] ?? {});
  if (holders.some((signPub) => !ctx.members.has(signPub)))
    return newGeneration(announced, ctx, resolved, await openAll(announced, tier, key));
  const missing = new Map([...resolved.devices].filter(([signPub]) => !holders.includes(signPub)));
  if (missing.size === 0) return announced;
  const added = await wrapsFor(key, missing);
  return { ...announced, wraps: { ...announced.wraps, [tier.id]: { ...announced.wraps[tier.id], ...added } } };
}
