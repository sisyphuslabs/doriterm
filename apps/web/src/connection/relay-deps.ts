import type { StaticKey } from "@doriface/crypto";
import { deviceStore, type KeyValueStore } from "../storage/idb.ts";
import { DEFAULT_SLOT, slotKeys } from "../mesh/identity-slots.ts";
import { loadDeviceKey } from "./device-key.ts";
import type { DialBudget } from "./relay-dial-budget.ts";

/**
 * What the relay path needs from the browser; tests replace the device key. `keySlot` names the identity the member
 * knows this browser by: a machine of a second mesh knows only that mesh's key (#2861). Unset is the default identity.
 */
export interface RelayDeps {
  readonly loadDeviceKey: (keySlot?: string) => Promise<StaticKey>;
  /** The page's relay upgrade budget every dial acquires from (relay-dial-budget.ts); a test passes its own. */
  readonly dials?: DialBudget | undefined;
}

/** The relay path's keys from one storage view: the page's, or the service worker's own over the same IndexedDB. */
export const relayDepsFor = (storage: KeyValueStore): RelayDeps => ({
  loadDeviceKey: (keySlot) => loadDeviceKey(slotKeys(storage, keySlot ?? DEFAULT_SLOT)),
});

export const BROWSER_DEPS: RelayDeps = relayDepsFor(deviceStore);

/** Loads the device key for a relay socket that is already open, closing the socket if the key cannot load. */
export async function deviceKeyFor(link: { close(): void }, deps: RelayDeps, keySlot?: string): Promise<StaticKey> {
  try {
    return await deps.loadDeviceKey(keySlot);
  } catch (error) {
    link.close();
    throw error;
  }
}
