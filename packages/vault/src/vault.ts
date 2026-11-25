import { bytesToHex } from "@noble/hashes/utils.js";
import {
  type Envelope,
  type EntryPayload,
  type Field,
  parseEntryName,
  toBase64,
  TypeVaultError,
  verifyEnvelope,
} from "typevault/core";
import type { VaultContext } from "./context.ts";
import type { VaultDoc } from "./doc.ts";
import { stateFor, TIER, type TierHandle } from "./keyholder.ts";
import { pruneOlder, pruneOutsiders, STRANGER_GRACE_MS } from "./prune.ts";
import { readDevice, readTier, recordId, type SignedWrap, signRecord, wrapDigest } from "./records.ts";
import {
  memberWraps,
  openersOf,
  type ResolvedTier,
  type ResolvedVault,
  resolveVault,
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

type Opened = { readonly envelope: Envelope; readonly payload: EntryPayload };

/** Every entry the current tier key signed that opens, with its payload. */
async function openAll(doc: VaultDoc, tier: ResolvedTier, handle: TierHandle): Promise<readonly Opened[]> {
  const state = stateFor(tier.gen, tier.publicKey);
  const current = Object.values(doc.entries).flatMap((byTier) => {
    const envelope = byTier[tier.id];
    return envelope !== undefined && verifyEnvelope(envelope, state) === undefined ? [envelope] : [];
  });
  const opened = await Promise.all(
    current.map(async (envelope) => ({ envelope, payload: await handle.open(envelope) })),
  );
  return opened.filter((item): item is Opened => item.payload !== undefined);
}

export async function readEntry(doc: VaultDoc, ctx: VaultContext, name: string): Promise<EntryRead> {
  const { tier } = resolveVault(doc, ctx);
  if (tier === undefined) return { kind: "missing" };
  const handle = await unlockTier(doc, ctx, tier);
  if (handle === undefined) return Object.keys(doc.entries).length > 0 ? { kind: "locked" } : { kind: "missing" };
  const match = (await openAll(doc, tier, handle)).find((item) => item.payload.name === name);
  if (match === undefined) return { kind: "missing" };
  const { id, rev } = match.envelope;
  if (!ctx.ledger.accept(entryMark(id), rev)) return { kind: "rolled-back" };
  return { kind: "open", id, rev, payload: match.payload };
}

const newEntryId = (): string => `${TIER}.${bytesToHex(crypto.getRandomValues(new Uint8Array(16)))}`;

const withEntry = (doc: VaultDoc, tierId: string, envelope: Envelope): VaultDoc => ({
  ...doc,
  entries: { ...doc.entries, [envelope.id]: { ...doc.entries[envelope.id], [tierId]: envelope } },
});

export async function writeEntry(
  doc: VaultDoc,
  ctx: VaultContext,
  name: string,
  fields: Readonly<Record<string, Field>>,
): Promise<VaultDoc> {
  const { tier } = resolveVault(doc, ctx);
  const handle = tier === undefined ? undefined : await unlockTier(doc, ctx, tier);
  if (tier === undefined || handle === undefined)
    throw new TypeVaultError("denied", "the mesh vault is locked on this device");
  const existing = (await openAll(doc, tier, handle)).find((item) => item.payload.name === name);
  const at = ctx.now();
  const id = existing?.envelope.id ?? newEntryId();
  const rev = (existing?.envelope.rev ?? 0) + 1;
  const created = existing?.payload.created ?? at;
  const payload: EntryPayload = { v: 1, name: parseEntryName(name), fields, tags: [], created, rotated: at };
  const envelope = await handle.seal({ id, rev, at, payload });
  ctx.ledger.accept(entryMark(id), rev);
  return withEntry(doc, tier.id, envelope);
}

async function announce(doc: VaultDoc, ctx: VaultContext): Promise<VaultDoc> {
  const held = doc.devices[ctx.self.signPub];
  const current = held === undefined ? undefined : readDevice(held, ctx.mesh);
  if (current?.recipient === ctx.key.recipient && current.protection === ctx.key.protection) return doc;
  const { recipient, protection } = ctx.key;
  const body = {
    v: 1,
    type: "vault-device",
    mesh: ctx.mesh,
    signPub: ctx.self.signPub,
    recipient,
    protection,
    at: ctx.now(),
  } as const;
  return { ...doc, devices: { ...doc.devices, [ctx.self.signPub]: await signRecord(body, ctx.self) } };
}

/** The tier key sealed to each device, each wrap signed by this member: who sealed it, for whom, to which key. */
async function signedWraps(
  ctx: VaultContext,
  tierId: string,
  handle: TierHandle,
  devices: ResolvedVault["devices"],
): Promise<VaultDoc["wraps"][string]> {
  const sealed = await Promise.all(
    [...devices].map(async ([holder, device]) => {
      const wrap = toBase64(await handle.wrapFor(device.recipient));
      const body = {
        v: 1,
        type: "vault-wrap",
        mesh: ctx.mesh,
        tier: tierId,
        holder,
        recipient: device.recipient,
        digest: wrapDigest(wrap),
        by: ctx.self.signPub,
        at: ctx.now(),
      } as const;
      const signed: SignedWrap = { ...(await signRecord(body, ctx.self)), wrap };
      return [holder, { [ctx.self.signPub]: signed }] as const;
    }),
  );
  return Object.fromEntries(sealed);
}

/**
 * A new generation wrapped to current members only, carrying `carried` entries re-sealed under it. Secret entries are
 * marked for replacement: a device that is gone saw them.
 */
async function newGeneration(doc: VaultDoc, ctx: VaultContext, resolved: ResolvedVault, carried: readonly Opened[]) {
  const gen = Math.max(resolved.highestGen, resolved.tier?.gen ?? 0) + 1;
  const handle = await ctx.key.generate(gen);
  const record = await signRecord(
    {
      v: 1,
      type: "vault-tier",
      mesh: ctx.mesh,
      tier: TIER,
      gen,
      ...handle.publicKey,
      by: ctx.self.signPub,
      at: ctx.now(),
    },
    ctx.self,
  );
  const tierId = recordId(record);
  let next: VaultDoc = { ...doc, tiers: { ...doc.tiers, [tierId]: record } };
  for (const { envelope, payload } of carried) {
    const flagged = Object.values(payload.fields).some((field) => field.type === "secret");
    const draft = {
      id: envelope.id,
      rev: envelope.rev + 1,
      at: ctx.now(),
      payload: { ...payload, ...(flagged ? { needsRotation: true } : {}) },
    };
    // oxlint-disable-next-line no-await-in-loop -- each entry is folded into the document in turn
    next = withEntry(next, tierId, await handle.seal(draft));
    ctx.ledger.accept(entryMark(envelope.id), draft.rev);
  }
  ctx.ledger.accept(TIER_MARK, gen);
  ctx.memory.remember(tierId, resolved.devices.keys());
  return { ...next, wraps: { ...next.wraps, [tierId]: await signedWraps(ctx, tierId, handle, resolved.devices) } };
}

/**
 * One device's share of keeping the vault: announce this device's key; start a generation when there is no trusted one
 * (never over a stale copy), after dropping what only keys outside the mesh produced; with the current key in hand, rotate when a device that is no longer a member was ever
 * seen holding a member-signed wrap of it (in this copy or remembered on this device: it saw the key), and otherwise wrap the key to every announced member whose current key has no
 * member-signed wrap. Without the key, it starts a new generation only when no current member's announced key has a
 * wrap at all (nobody can open it any more); otherwise it waits for a device that can.
 */
/**
 * A generation signed by someone this device does not know yet, still inside its grace (`pruneOutsiders` left it): likely
 * a member that joined after this device's mesh records were read. Starting another generation beside it would fork
 * the vault, so this device waits for its records to catch up, but on one clock per mesh that started the first time it
 * waited: fresh keys minted by a hostile writer cannot restart it and postpone the first vault for ever.
 */
function strangerTiers(doc: VaultDoc, ctx: VaultContext): boolean {
  const pending = Object.values(doc.tiers).some((record) => {
    const by = readTier(record, ctx.mesh)?.by;
    return by !== undefined && !ctx.members.has(by);
  });
  if (!pending) return false;
  const since = Date.parse(ctx.strangers.firstSeen(`waiting:${ctx.mesh}`, ctx.now()));
  return Date.parse(ctx.now()) - since <= STRANGER_GRACE_MS;
}

export async function maintain(doc: VaultDoc, ctx: VaultContext): Promise<VaultDoc> {
  if (!ctx.members.has(ctx.self.signPub)) return doc;
  const announced = await announce(pruneOutsiders(doc, ctx), ctx);
  const resolved = resolveVault(announced, ctx);
  const { tier, devices } = resolved;
  if (tier === undefined)
    return resolved.stale || strangerTiers(announced, ctx) ? announced : newGeneration(announced, ctx, resolved, []);
  const wraps = memberWraps(announced, ctx, tier.id);
  const openers = openersOf(announced, ctx, resolved);
  const handle = await unlockTier(announced, ctx, tier);
  if (handle === undefined) return openers.size > 0 ? announced : newGeneration(announced, ctx, resolved, []);
  const kept = pruneOlder(announced, tier, ctx);
  ctx.memory.remember(tier.id, wraps.keys());
  if ([...ctx.memory.holders(tier.id)].some((holder) => !ctx.members.has(holder)))
    return newGeneration(kept, ctx, resolved, await openAll(kept, tier, handle));
  const missing = new Map([...devices].filter(([holder]) => !openers.has(holder)));
  if (missing.size === 0) return kept;
  const added = await signedWraps(ctx, tier.id, handle, missing);
  ctx.memory.remember(tier.id, Object.keys(added));
  const merged = { ...kept.wraps[tier.id] };
  for (const [holder, bySigner] of Object.entries(added)) merged[holder] = { ...merged[holder], ...bySigner };
  return { ...kept, wraps: { ...kept.wraps, [tier.id]: merged } };
}
