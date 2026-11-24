import { type Envelope, EnvelopeSchema } from "typevault/core";
import { recordAt, type SignedRecord, signedBy } from "./records.ts";

/** The herdr document the vault lives in, on every machine's core. Machines store it; only devices read it. */
export const VAULT_DOC = "doriface-vault";

export interface VaultDoc {
  readonly v: 1;
  /** Device announcements by member signPub. */
  readonly devices: Readonly<Record<string, SignedRecord>>;
  /** Tier generations by record id. */
  readonly tiers: Readonly<Record<string, SignedRecord>>;
  /** base64 TypeVault wraps of a tier generation's key: tier record id -> member signPub -> wrap. */
  readonly wraps: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** TypeVault entry envelopes by entry id. */
  readonly entries: Readonly<Record<string, Envelope>>;
}

export const EMPTY_VAULT: VaultDoc = { v: 1, devices: {}, tiers: {}, wraps: {}, entries: {} };

type Json = Readonly<Record<string, unknown>>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function recordsIn(value: unknown): Record<string, SignedRecord> {
  if (!isObject(value)) return {};
  const out: Record<string, SignedRecord> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isObject(item) && typeof item["body"] === "string" && typeof item["sig"] === "string")
      out[key] = { body: item["body"], sig: item["sig"] };
  }
  return out;
}

function wrapsIn(value: unknown): Record<string, Record<string, string>> {
  if (!isObject(value)) return {};
  const out: Record<string, Record<string, string>> = {};
  for (const [tier, holders] of Object.entries(value)) {
    if (!isObject(holders)) continue;
    const kept = Object.entries(holders).filter((pair): pair is [string, string] => typeof pair[1] === "string");
    if (kept.length > 0) out[tier] = Object.fromEntries(kept);
  }
  return out;
}

function entriesIn(value: unknown): Record<string, Envelope> {
  if (!isObject(value)) return {};
  const out: Record<string, Envelope> = {};
  for (const [id, item] of Object.entries(value)) {
    const parsed = EnvelopeSchema.safeParse(item);
    if (parsed.success && parsed.data.id === id) out[id] = parsed.data;
  }
  return out;
}

/** The document as stored, keeping every well-formed item; anything else reads as an empty vault. */
export function parseVaultDoc(value: unknown): VaultDoc {
  if (!isObject(value) || value["v"] !== 1) return EMPTY_VAULT;
  return {
    v: 1,
    devices: recordsIn(value["devices"]),
    tiers: recordsIn(value["tiers"]),
    wraps: wrapsIn(value["wraps"]),
    entries: entriesIn(value["entries"]),
  };
}

const later = (a: SignedRecord, b: SignedRecord): SignedRecord => {
  const [atA, atB] = [recordAt(a), recordAt(b)];
  if (atA !== atB) return atA > atB ? a : b;
  return a.sig <= b.sig ? a : b;
};

function mergeDevices(a: VaultDoc["devices"], b: VaultDoc["devices"]): Record<string, SignedRecord> {
  const out: Record<string, SignedRecord> = {};
  for (const [signPub, record] of [...Object.entries(a), ...Object.entries(b)]) {
    if (!signedBy(record, signPub)) continue;
    const held = out[signPub];
    out[signPub] = held === undefined ? record : later(held, record);
  }
  return out;
}

function mergeWraps(a: VaultDoc["wraps"], b: VaultDoc["wraps"]): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [tier, holders] of [...Object.entries(a), ...Object.entries(b)]) {
    const into = (out[tier] ??= {});
    for (const [signPub, wrap] of Object.entries(holders)) {
      const held = into[signPub];
      into[signPub] = held === undefined || wrap < held ? wrap : held;
    }
  }
  return out;
}

const newer = (a: Envelope, b: Envelope): Envelope => {
  if (a.gen !== b.gen) return a.gen > b.gen ? a : b;
  if (a.rev !== b.rev) return a.rev > b.rev ? a : b;
  return a.sig <= b.sig ? a : b;
};

function mergeEntries(a: VaultDoc["entries"], b: VaultDoc["entries"]): Record<string, Envelope> {
  const out: Record<string, Envelope> = { ...a };
  for (const [id, envelope] of Object.entries(b)) {
    const held = out[id];
    out[id] = held === undefined ? envelope : newer(held, envelope);
  }
  return out;
}

const sorted = <T>(record: Readonly<Record<string, T>>): Record<string, T> =>
  Object.fromEntries(Object.entries(record).toSorted(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));

/**
 * Two copies of the vault as one: the union, keeping per key the newest validly signed announcement, every tier record,
 * the lowest wrap ciphertext, and the entry with the highest generation and revision. Commutative and idempotent, so
 * machines converge whichever copy a device reads first. Membership and envelope checks happen on read, not here.
 */
export function mergeVaults(a: VaultDoc, b: VaultDoc): VaultDoc {
  const wraps = mergeWraps(a.wraps, b.wraps);
  return {
    v: 1,
    devices: sorted(mergeDevices(a.devices, b.devices)),
    tiers: sorted({ ...a.tiers, ...b.tiers }),
    wraps: sorted(Object.fromEntries(Object.entries(wraps).map(([tier, holders]) => [tier, sorted(holders)]))),
    entries: sorted(mergeEntries(a.entries, b.entries)),
  };
}
