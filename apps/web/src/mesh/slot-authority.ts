import { base64urlEncode } from "@doriface/crypto";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import type { KeyValueStore } from "../storage/idb.ts";
import type { KeyGrant, KeyName, PublicHalves } from "../storage/key-authority.ts";
import { changeRecord } from "./mesh-record.ts";
import { DEFAULT_SLOT, type EnrollingClaim, type MeshRecord, storedRecord } from "./membership-list.ts";

export class SlotNotEnrolled extends Error {
  override readonly name = "SlotNotEnrolled";
}

const refuse = (why: string): never => {
  throw new SlotNotEnrolled(why);
};

const retiring = (record: MeshRecord, slot: string): boolean =>
  record.slots.some((claim) => claim.slot === slot && claim.phase === "retiring");

const RECORDED: Readonly<Record<KeyName, "signPub" | "devicePub">> = {
  "mesh-sign-key": "signPub",
  "device-key": "devicePub",
};
const KEY_NAMES: readonly KeyName[] = ["device-key", "mesh-sign-key"];

/** The membership or running join that holds the slot at `generation`, with the key public halves recorded for it. */
function entryAt(record: MeshRecord, slot: string, generation: number) {
  const held = record.memberships.find((entry) => entry.keySlot === slot && entry.generation === generation);
  if (held !== undefined) return held;
  return record.slots.find(
    (claim): claim is EnrollingClaim =>
      claim.slot === slot && claim.phase === "enrolling" && claim.generation === generation,
  );
}

/** The public halves of the keys stored in a slot now, as `MembershipStore` keys name them. */
export async function storedPublicHalves(keys: KeyValueStore): Promise<{ signPub?: string; devicePub?: string }> {
  const [signPub, devicePub] = await Promise.all([
    keys.get("mesh-sign-key").then((stored) => publicOf("mesh-sign-key", stored)),
    keys.get("device-key").then((stored) => publicOf("device-key", stored)),
  ]);
  return { ...(signPub === undefined ? {} : { signPub }), ...(devicePub === undefined ? {} : { devicePub }) };
}

/** The public half of a stored key, in every form a release has stored one, or undefined when none is stored. */
function publicOf(name: KeyName, stored: unknown): string | undefined {
  if (typeof stored !== "object" || stored === null) return undefined;
  const publicKey: unknown = Reflect.get(stored, "publicKey");
  if (publicKey instanceof Uint8Array) return base64urlEncode(publicKey);
  const secret: unknown = Reflect.get(stored, Reflect.get(stored, "kind") === "ed25519" ? "secretKey" : "privateKey");
  if (!(secret instanceof Uint8Array) || secret.length !== 32) return undefined;
  return base64urlEncode(name === "device-key" ? x25519.getPublicKey(secret) : ed25519.getPublicKey(secret));
}

/**
 * The live authority over one slot's keys, read from storage itself and not from what a context was told (review of
 * #2890). At load it fixes the generation the keys are loaded for: a membership's, a running join's, or none for the
 * default slot's pairing identity. Every use then checks that the slot is still at that generation and not being
 * retired, and that the key in hand is the very key stored there and recorded for that generation: a key held from
 * before, in any cache of any context, is refused once its mesh is left, its join retired, or its slot given new keys.
 */
export async function slotAuthority(storage: KeyValueStore, keys: KeyValueStore, slot: string): Promise<KeyGrant> {
  const record = await storedRecord(storage);
  const generation =
    record.memberships.find((held) => held.keySlot === slot)?.generation ??
    record.slots.flatMap((claim) => (claim.slot === slot && claim.phase === "enrolling" ? [claim.generation] : []))[0];
  if (retiring(record, slot)) refuse("This mesh identity is being removed from this browser.");
  if (generation === undefined && slot !== DEFAULT_SLOT) refuse("This mesh identity is not enrolled on this browser.");
  const stored = async (name: KeyName) => publicOf(name, await keys.get(name));
  const current = async (loaded: PublicHalves): Promise<boolean> => {
    const names = KEY_NAMES.filter((name) => loaded[name] !== undefined);
    const now = await Promise.all(names.map(stored));
    return names.every((name, index) => now[index] === base64urlEncode(loaded[name] ?? new Uint8Array()));
  };
  return {
    current,
    check: async (name, publicKey) => {
      const now = await storedRecord(storage);
      if (retiring(now, slot)) refuse("This mesh identity is being removed from this browser.");
      const entry = generation === undefined ? undefined : entryAt(now, slot, generation);
      if (generation !== undefined && entry === undefined)
        refuse("This mesh identity was left or replaced on this browser.");
      const recorded = entry?.[RECORDED[name]];
      const mine = base64urlEncode(publicKey);
      if ((await stored(name)) !== mine || (recorded !== undefined && recorded !== mine)) {
        refuse("This key is not this browser's key for that mesh any more.");
      }
    },
    bind: async (loaded) => {
      if (generation === undefined) return;
      const pubs = KEY_NAMES.flatMap((name) => {
        const key = loaded[name];
        return key === undefined ? [] : [[RECORDED[name], base64urlEncode(key)] as const];
      });
      // Already recorded, and the same keys: nothing to write. Any other key at this generation is refused.
      const settled = (entry: { readonly signPub?: string | undefined; readonly devicePub?: string | undefined }) =>
        pubs.every(([field, pub]) => {
          if (entry[field] !== undefined && entry[field] !== pub)
            refuse("This key is not this browser's key for that mesh.");
          return entry[field] === pub;
        });
      const seen = entryAt(await storedRecord(storage), slot, generation);
      if (seen !== undefined && settled(seen)) return;
      await changeRecord(storage, (now) => {
        const entry =
          entryAt(now, slot, generation) ?? refuse("This mesh identity was left or replaced on this browser.");
        settled(entry);
        const next = Object.fromEntries(pubs);
        const memberships = now.memberships.map((held) => (held === entry ? { ...held, ...next } : held));
        const slots = now.slots.map((claim) => (claim === entry ? { ...claim, ...next } : claim));
        return { next: { ...now, memberships, slots }, answer: undefined };
      });
    },
  };
}
