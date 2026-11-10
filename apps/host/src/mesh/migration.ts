import { HcRpcError, type MachineView } from "@doriface/protocol";
import type { HcMachines } from "./hc-machines.ts";
import type { AddReservation } from "./line-grants.ts";

/**
 * What a migration did. After `added` and `lost` the earlier entry is out of the list; after an `unremoved` that herdr
 * did not answer it may be; after every other outcome it is in the list as it was.
 */
export type Migration =
  | { readonly kind: "added"; readonly name: string }
  /** The dial budget had no room for the line's add: nothing was removed. */
  | { readonly kind: "refused"; readonly reason: string }
  /**
   * The removal failed and the reserved pair is given back. `refused`: herdr answered with a refusal, so the earlier
   * entry is in the list as it was. Otherwise herdr gave no answer (the call timed out or the link closed), and it may
   * have removed the entry before that (#1235).
   */
  | { readonly kind: "unremoved"; readonly reason: string; readonly refused: boolean }
  /** The line's add failed after the removal, and the earlier entry was added back. */
  | { readonly kind: "restored"; readonly reason: string }
  /** Another entry still holds the core (a second `already_added`); the earlier entry was added back. */
  | { readonly kind: "copied" }
  /** The line's add failed and adding the earlier entry back failed too: the machine is not in the list. */
  | { readonly kind: "lost"; readonly reason: string };

export interface MigrationParts {
  readonly machines: HcMachines;
  readonly reserve: (() => Promise<AddReservation>) | undefined;
  readonly log: (line: string) => void;
}

const kindOf = (error: unknown): string => (error instanceof HcRpcError ? error.kind : "unreachable");
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function addNamed(machines: HcMachines, names: readonly string[], via: string): Promise<string> {
  const [name, ...rest] = names;
  if (name === undefined) throw new Error("the member's name and its fallbacks are used on this core");
  try {
    await machines.add(name, via);
    return name;
  } catch (error) {
    if (kindOf(error) !== "name_taken") throw error;
    return addNamed(machines, rest, via);
  }
}

/**
 * Replaces `old` with the mesh line `via` for the same core (design section 8.1). herdr refuses a second entry for one
 * core, so `old` has to go first; the line's add is reserved before that, so a full dial budget removes nothing, and a
 * line that still fails to add puts `old` back as it was. The machine is out of the list only while the add runs.
 */
export async function migrate(
  parts: MigrationParts,
  old: MachineView,
  names: readonly string[],
  via: string,
): Promise<Migration> {
  // A fresh pair: the add that met `already_added` spent one upgrade on herdr's probe and dropped the rest.
  const reserved = await parts.reserve?.();
  if (reserved !== undefined && !reserved.ok) return { kind: "refused", reason: reserved.reason };
  try {
    await parts.machines.rm(old.name);
  } catch (error) {
    // No add follows a failed removal, so the pair taken for the line's add goes back (#728).
    if (reserved?.ok === true) reserved.failed();
    const reason = `removing ${old.name} failed: ${kindOf(error)}: ${messageOf(error)}`;
    return { kind: "unremoved", reason, refused: error instanceof HcRpcError };
  }
  parts.log(`mesh: removed machine ${old.name} to replace it with the mesh line`);
  try {
    return { kind: "added", name: await addNamed(parts.machines, names, via) };
  } catch (error) {
    if (reserved?.ok === true) reserved.failed();
    const reason = `${kindOf(error)}: ${messageOf(error)}`;
    try {
      await parts.machines.restore(old);
    } catch (restoreError) {
      parts.log(`mesh: adding machine ${old.name} back failed: ${messageOf(restoreError)}`);
      return { kind: "lost", reason: `${reason}; adding ${old.name} back failed: ${messageOf(restoreError)}` };
    }
    parts.log(`mesh: the mesh line failed (${reason}); added machine ${old.name} back`);
    return kindOf(error) === "already_added" ? { kind: "copied" } : { kind: "restored", reason };
  }
}
