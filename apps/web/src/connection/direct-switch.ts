import { canForwardPlainWs } from "./direct-forward.ts";

/**
 * The direct path is off (owner decision, #2070): every session, the push stream included, goes through the relay, and
 * nothing names a saved direct address to the person. The modules behind the path stay, so a later decision turns it
 * on here and nowhere else. Until then an address an older file holds (v0.1.0-v0.1.2 offered the field, #458) is kept
 * in the file and left unused.
 */
export const DIRECT_PATH_ENABLED: boolean = false;

/**
 * Whether this page may run a direct attempt at all: the switch, and the desktop shell's forwarder, the only thing that
 * may dial a saved address (#449, #1381 §8). Every label that would name a direct address asks this first.
 */
export function directPathAvailable(scope: object = globalThis): boolean {
  return DIRECT_PATH_ENABLED && canForwardPlainWs(scope);
}
