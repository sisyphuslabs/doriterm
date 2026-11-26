import { Button, SettingRow } from "@doriface/ui";
import { selectMembership, useBrowserMembership, useHeldMeshes } from "../mesh/membership-state.ts";

/**
 * The meshes this browser is a member of, when there is more than one (#2861): each with what it knows this browser as,
 * and the one in view marked. Showing another puts its machines, its device row and its Leave in front.
 */
export function MeshPicker() {
  const meshes = useHeldMeshes();
  const shown = useBrowserMembership();
  if (meshes.length < 2) return null;
  return (
    <ul aria-label="Meshes" className="flex flex-col divide-y divide-border">
      {meshes.map(({ slot, view }) => (
        <li key={slot}>
          <SettingRow
            inline
            className="border-b-0"
            title={<span className="min-w-0 [overflow-wrap:anywhere]">{`Mesh ${view.mesh}`}</span>}
            description={
              view.phase === "removed"
                ? "This browser was removed from this mesh"
                : `${view.machines.length} machines · as ${view.self?.name ?? "this browser"}`
            }
            control={
              view.mesh === shown.mesh ? (
                <span className="text-sm text-muted-foreground">In view</span>
              ) : (
                <Button size="sm" onClick={() => void selectMembership(slot)}>
                  Show
                </Button>
              )
            }
          />
        </li>
      ))}
    </ul>
  );
}
