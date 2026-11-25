import { type Envelope, EnvelopeSchema } from "typevault/core";
import { cleanVault } from "./clean.ts";
import { recordAt, type SignedRecord, type SignedWrap } from "./records.ts";

/** The herdr document the vault lives in, on every machine's core. Machines store it; only devices read it. */
export const VAULT_DOC = "doriface-vault";

/**
 * Everything is kept as sets keyed by who could have produced it, never as one winner chosen by a field anyone can
 * write: an extra item from a hostile writer sits beside the genuine one and is ignored on read; it never replaces it.
 */
export interface VaultDoc {
  readonly v: 1;
  /** Device announcements by member signPub (only that member can sign one). */
  readonly devices: Readonly<Record<string, SignedRecord>>;
  /** Tier generations by record id. */
  readonly tiers: Readonly<Record<string, SignedRecord>>;
  /** Signed wraps: tier record id -> holder signPub -> signer signPub -> wrap. */
  readonly wraps: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, SignedWrap>>>>>>;
  /** TypeVault envelopes: entry id -> tier record id (whose key signed it) -> envelope. */
  readonly entries: Readonly<Record<string, Readonly<Record<string, Envelope>>>>;
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

/** Two levels of string keys over `leaf`, dropping every branch that holds nothing. */
function nested<T>(value: unknown, leaf: (item: unknown) => T | undefined): Record<string, Record<string, T>> {
  if (!isObject(value)) return {};
  const out: Record<string, Record<string, T>> = {};
  for (const [outer, inner] of Object.entries(value)) {
    if (!isObject(inner)) continue;
    const kept = Object.entries(inner).flatMap(([key, item]) => {
      const parsed = leaf(item);
      return parsed === undefined ? [] : [[key, parsed] as const];
    });
    if (kept.length > 0) out[outer] = Object.fromEntries(kept);
  }
  return out;
}

const wrapIn = (item: unknown): SignedWrap | undefined =>
  isObject(item) &&
  typeof item["body"] === "string" &&
  typeof item["sig"] === "string" &&
  typeof item["wrap"] === "string"
    ? { body: item["body"], sig: item["sig"], wrap: item["wrap"] }
    : undefined;

const envelopeIn = (item: unknown): Envelope | undefined => {
  const parsed = EnvelopeSchema.safeParse(item);
  return parsed.success ? parsed.data : undefined;
};

/** The document as stored, keeping every well-formed item; anything else reads as an empty vault. */
export function parseVaultDoc(value: unknown): VaultDoc {
  if (!isObject(value) || value["v"] !== 1) return EMPTY_VAULT;
  const wraps = isObject(value["wraps"]) ? value["wraps"] : {};
  return {
    v: 1,
    devices: recordsIn(value["devices"]),
    tiers: recordsIn(value["tiers"]),
    wraps: Object.fromEntries(
      Object.entries(wraps).flatMap(([tier, holders]) => {
        const kept = nested(holders, wrapIn);
        return Object.keys(kept).length === 0 ? [] : [[tier, kept] as const];
      }),
    ),
    entries: nested(value["entries"], envelopeIn),
  };
}

const bySig = <T extends { readonly sig: string }>(a: T, b: T): T => (a.sig <= b.sig ? a : b);
const laterRecord = <T extends SignedRecord>(a: T, b: T): T => {
  const [atA, atB] = [recordAt(a), recordAt(b)];
  return atA === atB ? bySig(a, b) : atA > atB ? a : b;
};
const newerEnvelope = (a: Envelope, b: Envelope): Envelope => (a.rev === b.rev ? bySig(a, b) : a.rev > b.rev ? a : b);

function union<T>(a: Readonly<Record<string, T>>, b: Readonly<Record<string, T>>, pick: (x: T, y: T) => T) {
  const out: Record<string, T> = { ...a };
  for (const [key, item] of Object.entries(b)) {
    const held = out[key];
    out[key] = held === undefined ? item : pick(held, item);
  }
  return out;
}

type Rec<T> = Readonly<Record<string, T>>;
const union2 = <T>(a: Rec<Rec<T>>, b: Rec<Rec<T>>, pick: (x: T, y: T) => T) => union(a, b, (x, y) => union(x, y, pick));
const union3 = <T>(a: Rec<Rec<Rec<T>>>, b: Rec<Rec<Rec<T>>>, pick: (x: T, y: T) => T) =>
  union(a, b, (x, y) => union2(x, y, pick));

/**
 * Two copies as one. Each is cleaned first (`cleanVault` drops whatever is not signed by who it claims), so at each
 * key of the union the only choice is between items the same signer or tier key produced (later announcement, later wrap,
 * higher revision). Commutative and idempotent, so machines converge whichever copy a device reads first. Who counts
 * as a member is decided on read, not here.
 */
export function mergeVaults(a: VaultDoc, b: VaultDoc, mesh: string): VaultDoc {
  const [x, y] = [cleanVault(a, mesh), cleanVault(b, mesh)];
  return cleanVault(
    {
      v: 1,
      devices: union(x.devices, y.devices, laterRecord),
      tiers: union(x.tiers, y.tiers, bySig),
      wraps: union3(x.wraps, y.wraps, laterRecord),
      entries: union2(x.entries, y.entries, newerEnvelope),
    },
    mesh,
  );
}
