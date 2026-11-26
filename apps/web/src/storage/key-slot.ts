import type { KeyValueStore } from "./idb.ts";

/**
 * Where one browser identity keeps its keys. The first identity is the one this browser always had: its keys sit under
 * their plain names (`device-key`, `mesh-sign-key`), which is what pairing a device to one host uses and what every
 * membership before #2861 rests on. Every further mesh this browser joins gets a slot of its own, so no key is shown to
 * two meshes and one mesh cannot link this browser to its identity in another.
 */
export const DEFAULT_SLOT = "";

const PREFIX = "mesh-identity/";
const views = new WeakMap<KeyValueStore, Map<string, KeyValueStore>>();

/**
 * The storage one slot's keys are read and written through: the same store, with every key under the slot's prefix.
 * One view per slot and store, because the key loaders remember a pending creation per store object and a fresh view per
 * call would let two first loads each create a key.
 */
export function slotStore(storage: KeyValueStore, slot: string): KeyValueStore {
  if (slot === DEFAULT_SLOT) return storage;
  const held = views.get(storage) ?? new Map<string, KeyValueStore>();
  views.set(storage, held);
  const known = held.get(slot);
  if (known !== undefined) return known;
  const scoped: KeyValueStore = {
    get: (key) => storage.get(`${PREFIX}${slot}/${key}`),
    put: (key, value) => storage.put(`${PREFIX}${slot}/${key}`, value),
  };
  held.set(slot, scoped);
  return scoped;
}

/** A slot name nothing else uses: random, so it says nothing about the mesh it will hold. */
export const newSlot = (): string => crypto.randomUUID();
