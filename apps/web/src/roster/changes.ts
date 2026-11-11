import type { JsonObject, MachineView } from "@doriface/protocol";
import { docSpaces, type DocSpace } from "@doriface/protocol/layout";

/** What changed in the machine roster between two `machine.list` answers, by permanent machine id. */
export type MachineChange =
  | { readonly kind: "machine-added"; readonly machine: MachineView }
  | { readonly kind: "machine-removed"; readonly id: string; readonly name: string }
  | { readonly kind: "machine-renamed"; readonly id: string; readonly from: string; readonly to: string }
  | {
      readonly kind: "machine-line";
      readonly id: string;
      readonly name: string;
      readonly from: string;
      readonly to: string;
    };

/** What changed in one machine's layout document between two reads, by space id (`machine` null for this core). */
export type SpaceChange =
  | { readonly kind: "space-added"; readonly machine: string | null; readonly space: DocSpace }
  | { readonly kind: "space-removed"; readonly machine: string | null; readonly id: string; readonly name: string }
  | {
      readonly kind: "space-renamed";
      readonly machine: string | null;
      readonly id: string;
      readonly from: string;
      readonly to: string;
    }
  | { readonly kind: "spaces-reordered"; readonly machine: string | null; readonly order: readonly string[] };

export type RosterChange = MachineChange | SpaceChange;

export function diffMachines(before: readonly MachineView[], after: readonly MachineView[]): readonly MachineChange[] {
  const was = new Map(before.map((view) => [view.id, view]));
  const changes: MachineChange[] = [];
  for (const view of after) {
    const old = was.get(view.id);
    if (old === undefined) {
      changes.push({ kind: "machine-added", machine: view });
      continue;
    }
    if (old.name !== view.name) changes.push({ kind: "machine-renamed", id: view.id, from: old.name, to: view.name });
    if (old.state !== view.state) {
      changes.push({ kind: "machine-line", id: view.id, name: view.name, from: old.state, to: view.state });
    }
  }
  const now = new Set(after.map((view) => view.id));
  for (const view of before) {
    if (!now.has(view.id)) changes.push({ kind: "machine-removed", id: view.id, name: view.name });
  }
  return changes;
}

const sameOrder = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, index) => id === b[index]);

export function diffSpaces(
  machine: string | null,
  before: JsonObject | null,
  after: JsonObject | null,
): readonly SpaceChange[] {
  const was = before === null ? [] : docSpaces(before);
  const now = after === null ? [] : docSpaces(after);
  const known = new Map(was.map((space) => [space.id, space]));
  const changes: SpaceChange[] = [];
  for (const space of now) {
    const old = known.get(space.id);
    if (old === undefined) changes.push({ kind: "space-added", machine, space });
    else if (old.name !== space.name) {
      changes.push({ kind: "space-renamed", machine, id: space.id, from: old.name, to: space.name });
    }
  }
  const kept = new Set(now.map((space) => space.id));
  for (const space of was) {
    if (!kept.has(space.id)) changes.push({ kind: "space-removed", machine, id: space.id, name: space.name });
  }
  const order = now.map((space) => space.id);
  const orderBefore = was.filter((space) => kept.has(space.id)).map((space) => space.id);
  if (
    !sameOrder(
      orderBefore,
      order.filter((id) => known.has(id)),
    )
  ) {
    changes.push({ kind: "spaces-reordered", machine, order });
  }
  return changes;
}
