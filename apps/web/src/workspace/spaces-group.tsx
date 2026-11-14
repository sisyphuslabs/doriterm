import { IconButton, MachineHeader, RowWithActions, SidebarSection, SpaceRow, cn, type Space } from "@doriface/ui";
import { Plus } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { desktopBridge } from "../desktop/bridge.ts";
import { useConnectionSettings } from "../connection/store.ts";
import { SpaceActions, SpaceMenuItems } from "./space-actions.tsx";
import { type HeaderButton, MachineGroup } from "./machine-group.tsx";
import { MachineNotice } from "./machine-notice.tsx";
import { stateLabel, type MachineEntry } from "./machines.ts";
import { MachinesListError } from "./machines-list-error.tsx";
import { useConnectionNotice } from "./reconnect-status.tsx";
import { removable } from "./remove-machine.tsx";
import { SpaceList, type SpaceReorder } from "./space-list.tsx";
import { SpaceNameInput } from "./space-name-input.tsx";
import { filterMachineGroups, filterSpaces } from "./sidebar-filter.ts";
import { FilterButton } from "./sidebar-filter-field.tsx";
import { machineGroups } from "./sidebar-model.ts";
import { useCollapsed, useSpaceColors } from "./sidebar-prefs.ts";
import { useMachineReorder } from "./use-machine-reorder.tsx";
import { useSpaceSelection } from "./space-selection.ts";
import { useMachinesContext } from "./use-machines.ts";

export interface SpacesGroupProps {
  /** Opens a machine's first terminal, from its header. */
  readonly onOpen: (address: string) => void;
  readonly rail?: boolean;
  /** The sidebar filter's query; the selected space stays listed whatever it is. */
  readonly query?: string;
  /** Shows the filter button in the header: only where the filter field is (the desktop sidebar, not the phone list). */
  readonly filterable?: boolean;
  /** The phone's Spaces screen: its title already says "Spaces", and each row opens the space's own screen. */
  readonly phone?: boolean;
}

const ALARM = new Set(["unreachable", "needs_login"]);

/**
 * herdr-app's row under a machine with no spaces yet: starts the first one there. It is a ghost Button's inks, so its
 * disabled state dims with them, never a fade over its label (#1243).
 */
function NewSpaceThere({ disabled, onClick }: { readonly disabled: boolean; readonly onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-(--row) min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm text-foreground/85 outline-none",
        "enabled:hover:bg-hover enabled:hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring",
        "disabled:text-muted-foreground disabled:[&_svg]:text-disabled-glyph",
      )}
    >
      <Plus aria-hidden className="size-4 shrink-0" />
      <span className="truncate">New space there</span>
    </button>
  );
}

/**
 * The spaces. With one machine they are one list whose header starts a new space; once more than one machine is
 * known, each machine is a list headed by its row (state, the tabs of its spaces, New space there), in the machines'
 * order.
 */
export function SpacesGroup({ onOpen, rail = false, query = "", filterable = false, phone = false }: SpacesGroupProps) {
  const machines = useMachinesContext();
  if (!machines.machinesListed) return <SpacesLoading rail={rail} />;
  return (
    <SpacesLists onOpen={onOpen} rail={rail} query={query} filterable={filterable} phone={phone} machines={machines} />
  );
}

/** Holds the spaces' place, labeled, until the first machine.list answer: one row, where the first machine row goes. */
function SpacesLoading({ rail }: { readonly rail: boolean }) {
  return (
    <SidebarSection title="Spaces" className={rail ? "[&>header]:sr-only" : "pt-2"}>
      <div
        role="status"
        aria-label="Loading machines and spaces"
        className={cn("flex h-(--row) items-center text-xs text-muted-foreground", rail ? "justify-center" : "px-2")}
      >
        {rail ? <span aria-hidden className="size-1.5 rounded-full bg-dim" /> : "Loading machines…"}
      </div>
    </SidebarSection>
  );
}

function SpacesLists({
  onOpen,
  rail,
  query,
  filterable,
  phone,
  machines,
}: SpacesGroupProps & {
  readonly rail: boolean;
  readonly query: string;
  readonly filterable: boolean;
  readonly phone: boolean;
  readonly machines: ReturnType<typeof useMachinesContext>;
}) {
  const settings = useConnectionSettings();
  const ownComputer = desktopBridge() !== null && settings.mode === "loopback";
  // The layout documents' spaces (#404): picking one shows it on the tab it showed last.
  const { spaces, selected, select, move } = useSpaceSelection();
  const colors = useSpaceColors(
    useMemo(() => spaces.map((space) => space.id), [spaces]),
    machines.entries.find((machine) => machine.local)?.core ?? "",
  );
  const colored = spaces.map((space): Space => {
    const color = colors[space.id];
    return color === undefined ? space : Object.assign({}, space, { color });
  });
  const [editing, setEditing] = useState<string | null>(null);
  // A space row: the list owns its wrapper (drag id, offset), so this is what a person acts on inside it.
  const spaceRow = (space: Space, grouped: boolean, reorder: SpaceReorder | undefined) => {
    if (!rail && space.id === editing)
      return (
        <div data-drag-ignore>
          <SpaceNameInput space={space} onClose={() => setEditing(null)} />
        </div>
      );
    const button = (
      <div
        className="contents"
        {...(reorder === undefined ? {} : { "data-reorder-keys": "", onKeyDown: reorder.onKeyDown })}
      >
        <SpaceRow
          space={space}
          selected={space.id === selected}
          onSelect={select}
          rail={rail}
          hideMachine={grouped}
          chevron={phone}
        />
      </div>
    );
    // A phone row only opens its space: the space screen's header holds what can be done with it.
    if (phone) return button;
    return (
      <RowWithActions
        row={button}
        // The rail has no room for the "..." button, but its right-click opens the same menu (#699).
        actions={
          rail ? null : (
            <span data-drag-ignore className="flex items-center">
              <SpaceActions space={space} reorder={reorder} />
            </span>
          )
        }
        menu={<SpaceMenuItems space={space} reorder={reorder} />}
      />
    );
  };
  const editName = rail ? undefined : (space: Space): void => setEditing(space.id);
  const filtering = query.trim() !== "";
  const listOf = (own: readonly Space[], grouped: boolean) => (
    <SpaceList
      spaces={own}
      // A filtered list hides rows, so a move by position would land among rows the person cannot see.
      move={rail || filtering ? undefined : move}
      onDoubleClick={editName}
      row={(space, reorder) => spaceRow(space, grouped, reorder)}
    />
  );
  const allGrouped = machineGroups(machines.entries, colored);
  const grouped = allGrouped === undefined ? undefined : filterMachineGroups(allGrouped, query, selected);
  const shownSpaces = filterSpaces(colored, query, selected);
  // The icon rail has no room for a drag handle or a menu; the full sidebar reorders.
  const list = useRef<HTMLDivElement>(null);
  const { reorderOf, overlay } = useMachineReorder(list, machines.entries, !rail && !filtering);
  const [collapsed, toggle] = useCollapsed(machines.entries);
  const local = machines.entries.find((machine) => machine.local);
  const newSpaceOn = (machine: MachineEntry): void =>
    machine.local ? machines.start({}) : machines.newTerminalOn(machine.name);
  const showFilter = filterable && !rail;
  const newHere =
    // The phone's Spaces screen hides this header under its own title, whose + already starts one.
    allGrouped !== undefined || local === undefined || rail || phone ? undefined : (
      <IconButton label="New space" icon={<Plus />} onClick={() => machines.start({})} />
    );
  // While this device's own link is down, the machine list it last read is not news: no row claims a live link (#476).
  const notice = useConnectionNotice();
  const linkDown = notice === null ? null : "unknown";
  const header = (machine: MachineEntry, tabs: number, button: HeaderButton | undefined) => (
    <MachineHeader
      {...(button === undefined ? {} : { buttonProps: button })}
      name={machine.name}
      local={machine.local && ownComputer}
      state={linkDown !== null ? linkDown : machine.local && ownComputer ? "this machine" : stateLabel(machine.state)}
      alarm={linkDown === null && ALARM.has(machine.state)}
      tabs={tabs}
      connected={linkDown === null && machine.state === "connected"}
      rail={rail}
      collapsed={collapsed.includes(machine.core) && !filtering}
      // A filter opens every machine to show its matches, so a fold toggle there would change a state nothing shows (#850).
      {...(filtering ? {} : { onToggle: () => toggle(machine.core) })}
      onNewSpace={() => newSpaceOn(machine)}
      {...(machine.first === undefined ? {} : { onOpen: () => onOpen(machine.first ?? "") })}
    />
  );
  return (
    <SidebarSection
      title="Spaces"
      {...(grouped === undefined ? { count: shownSpaces.length } : {})}
      {...(showFilter || newHere !== undefined
        ? {
            action: (
              // One right margin for the header's buttons, as the lone New space had, so none spills past the header.
              <span className="-mr-1 flex items-center gap-0.5">
                {showFilter ? <FilterButton /> : null}
                {newHere}
              </span>
            ),
          }
        : {})}
      className={rail || phone ? "[&>header]:sr-only" : "pt-2"}
    >
      {/* While the link is down the connection notice says it once; the failed list would only repeat it (#545). */}
      {machines.listError === undefined || linkDown !== null ? null : (
        <MachinesListError cause={machines.listError} className="mx-1 mt-1" />
      )}
      {grouped === undefined ? (
        <section aria-label={ownComputer ? "Spaces on this machine" : "Spaces on connected machine"}>
          {listOf(shownSpaces, false)}
        </section>
      ) : (
        <div ref={list} className="relative flex flex-col gap-6">
          {overlay}
          {grouped.map(({ machine, spaces: own, tabs }, index) => (
            <MachineGroup
              key={machine.id}
              core={machine.core}
              name={machine.name}
              reorder={reorderOf(machine, index)}
              header={(button) => header(machine, tabs, button)}
              onRemove={
                !machine.local && removable(machines.views.find((view) => view.id === machine.core))
                  ? machines.remove
                  : undefined
              }
            >
              {collapsed.includes(machine.core) && !filtering ? null : (
                <>
                  {listOf(own, true)}
                  {own.length > 0 || rail || filtering ? null : (
                    <NewSpaceThere
                      disabled={linkDown !== null || machine.state !== "connected"}
                      onClick={() => newSpaceOn(machine)}
                    />
                  )}
                  {machine.local || rail ? null : <MachineNotice name={machine.name} />}
                </>
              )}
            </MachineGroup>
          ))}
        </div>
      )}
    </SidebarSection>
  );
}
