import { type Envelope, verifyEnvelope } from "typevault/core";
import type { VaultDoc } from "./doc.ts";
import { stateFor } from "./keyholder.ts";
import {
  readDevice,
  readTier,
  readWrap,
  recordId,
  type SignedRecord,
  type SignedWrap,
  type TierBody,
} from "./records.ts";

/** Per signer, its newest generation only (ties: the lower record id): one signer cannot grow the tier set. */
type KeptTier = TierBody & { readonly id: string; readonly record: SignedRecord };

function newestPerSigner(tiers: VaultDoc["tiers"], mesh: string): Map<string, KeptTier> {
  const best = new Map<string, KeptTier>();
  for (const [id, record] of Object.entries(tiers)) {
    const body = readTier(record, mesh);
    if (body === undefined || recordId(record) !== id) continue;
    const held = best.get(body.by);
    if (held === undefined || body.gen > held.gen || (body.gen === held.gen && id < held.id))
      best.set(body.by, { ...body, id, record });
  }
  return new Map([...best.values()].map((tier) => [tier.id, tier]));
}

const keepWhere = <T>(record: Readonly<Record<string, T>>, keep: (key: string, item: T) => boolean) =>
  Object.fromEntries(Object.entries(record).filter(([key, item]) => keep(key, item)));

const nonEmpty = <T>(record: Readonly<Record<string, Readonly<Record<string, T>>>>) =>
  keepWhere(record, (_key, inner) => Object.keys(inner).length > 0);

/**
 * Drops everything that is not what it claims, using signatures only (no membership, no clock): device records not
 * signed by the member they are filed under, tier records not filed under their id, wraps not signed by the signer they
 * are filed under for that tier and holder, envelopes not signed by the tier key they are filed under. Membership is a
 * reader's view and may lag, so it never decides what is deleted here.
 */
export function cleanVault(doc: VaultDoc, mesh: string): VaultDoc {
  const tiers = newestPerSigner(doc.tiers, mesh);
  const wraps = Object.fromEntries(
    Object.entries(doc.wraps)
      .filter(([tier]) => tiers.has(tier))
      .map(([tier, holders]) => {
        const kept = Object.fromEntries(
          Object.entries(holders).map(([holder, signers]) => [
            holder,
            keepWhere<SignedWrap>(signers, (by, stored) => readWrap(stored, mesh, { tier, holder, by }) !== undefined),
          ]),
        );
        return [tier, nonEmpty(kept)];
      }),
  );
  const entries = Object.fromEntries(
    Object.entries(doc.entries).map(([id, byTier]) => [
      id,
      keepWhere<Envelope>(byTier, (tierId, envelope) => {
        const tier = tiers.get(tierId);
        if (tier === undefined || envelope.id !== id || envelope.gen !== tier.gen) return false;
        const state = stateFor(tier.gen, { recipient: tier.recipient, signPublic: tier.signPublic });
        return verifyEnvelope(envelope, state, { ignoreClock: true }) === undefined;
      }),
    ]),
  );
  return {
    v: 1,
    devices: keepWhere(doc.devices, (signPub, record) => readDevice(record, mesh)?.signPub === signPub),
    tiers: Object.fromEntries([...tiers.values()].map((tier) => [tier.id, tier.record])),
    wraps: nonEmpty(wraps),
    entries: nonEmpty(entries),
  };
}
