import type { ConnectionSettings } from "../connection/settings.ts";
import type { BundleView } from "./bundle-view.ts";
import { DEFAULT_SLOT } from "./membership-list.ts";

/** The membership one selected machine is reached through: whose keys sign for it, and which mesh it belongs to. */
export interface MeshContext {
  readonly slot: string;
  readonly view: BundleView;
  readonly hostId: string;
}

/**
 * The membership the selected machine belongs to, read from the selection itself (review of #2890): a machine learned
 * from a mesh carries its slot and mesh; a paired machine is the default identity's. Undefined, so whatever acts for a
 * mesh stops, when that membership is gone, is not joined, names another mesh, or does not list the machine: an action
 * signed by one mesh's key never goes to another mesh's machines.
 */
export function contextOf(
  settings: ConnectionSettings,
  views: ReadonlyMap<string, BundleView>,
): MeshContext | undefined {
  const slot = settings.viewMember === true ? (settings.keySlot ?? DEFAULT_SLOT) : DEFAULT_SLOT;
  const view = views.get(slot);
  if (view === undefined || view.phase !== "joined" || settings.hostId === "") return undefined;
  if (settings.meshId !== undefined && settings.meshId !== view.mesh) return undefined;
  if (!view.machines.some((machine) => machine.hostId === settings.hostId)) return undefined;
  return { slot, view, hostId: settings.hostId };
}
