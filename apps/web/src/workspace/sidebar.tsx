import type { Terminal } from "@doriface/protocol";
import { IconButton, SidebarFooter, SidebarFooterItem, cn } from "@doriface/ui";
import { Link } from "@tanstack/react-router";
import { PanelLeftOpen, Plus, Search, Settings } from "lucide-react";
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { RegionBoundary } from "../crash/region-boundary.tsx";
import { useActionKeys } from "../keys/use-action-keys.ts";
import { usePendingUpdate } from "../update/update-store.ts";
import { SidebarLists } from "./agent-lists.tsx";
import { DEFAULT_SIDEBAR_WIDTH } from "./layout.ts";
import { useSidebarSize } from "./layout-store.ts";
import { RovingLists } from "./roving-lists.tsx";
import { SidebarEdge } from "./sidebar-edge.tsx";
import { SidebarFilterField, useSidebarFilter } from "./sidebar-filter-field.tsx";
import { useMachinesContext } from "./use-machines.ts";

export interface SidebarProps {
  readonly terminals: readonly Terminal[];
  readonly active: string | null;
  readonly onOpen: (address: string) => void;
  readonly onPalette: () => void;
  /** Overrides the stored rail preference when given. */
  readonly rail?: boolean;
  /** Called by the rail's Expand sidebar item instead of clearing the stored rail preference. */
  readonly onExpand?: () => void;
  /** Renders as a fixed-width overlay drawer: never a rail and without a resize edge. */
  readonly drawer?: boolean;
}

/** Until it is measured, the rail's width on the web (--sidebar-rail-width, 2.75rem). */
const RAIL_PX = 44;

export function Sidebar({
  terminals,
  active,
  onOpen,
  onPalette,
  rail: railProp,
  onExpand,
  drawer = false,
}: SidebarProps) {
  const paletteKeys = useActionKeys("app.palette");
  const filter = useSidebarFilter();
  const machines = useMachinesContext();
  const update = usePendingUpdate();
  const [{ sidebarWidth, rail: storedRail }, setSize] = useSidebarSize();
  const rail = drawer ? false : (railProp ?? storedRail);
  // The rail has no room for the field: its rows are not filtered either.
  const query = rail ? "" : filter.query;
  const [dragging, setDragging] = useState(false);
  const aside = useRef<HTMLElement | null>(null);
  const [railPx, setRailPx] = useState(RAIL_PX);
  useLayoutEffect(() => {
    if (rail && aside.current !== null) setRailPx(Math.round(aside.current.getBoundingClientRect().width));
  }, [rail]);
  // A width the person dragged to wins over --sidebar-width; the default leaves the token in charge.
  const style: CSSProperties | undefined =
    drawer || rail || sidebarWidth === DEFAULT_SIDEBAR_WIDTH ? undefined : { width: `${sidebarWidth}px` };
  return (
    <aside
      ref={aside}
      aria-label="Workspace"
      data-rail={rail || undefined}
      style={style}
      className={cn(
        "motion-arrive relative flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar [--arrive-from:none]",
        drawer ? "h-full w-(--sidebar-drawer-width)" : rail ? "w-(--sidebar-rail-width)" : "w-(--sidebar-width)",
        // One transition list: the arrival's opacity and transform (motion-arrive) and, unless a drag is under way, the width.
        dragging
          ? "transition-[opacity,transform] duration-(--duration-standard) ease-out"
          : "transition-[width,opacity,transform] duration-(--duration-standard) ease-out",
        "motion-reduce:transition-none motion-reduce:duration-0",
      )}
    >
      <div
        data-titlebar
        className={cn(
          "flex h-11 shrink-0 items-center gap-1",
          // The shell's sidebar toggle sits at the start of this row (#415); the app icon and title follow it.
          rail ? "justify-center" : "pr-2 pl-(--titlebar-leading)",
        )}
      >
        {rail ? null : (
          <>
            {/* herdr-app's titlebar: a 16 px app icon, then the name 11 px after it, 14 px semibold. */}
            <div className="flex min-w-0 flex-1 items-center gap-2.75">
              <img src="/icon.svg" alt="" className="size-4 shrink-0" />
              <span className="truncate text-base font-semibold text-sidebar-foreground">Doriterm</span>
            </div>
            <IconButton
              label="Command palette"
              {...(paletteKeys === undefined ? {} : { keys: paletteKeys })}
              icon={<Search />}
              onClick={onPalette}
            />
          </>
        )}
      </div>
      {rail ? null : <SidebarFilterField />}
      <RegionBoundary
        region="sidebar"
        title="The sidebar could not be drawn"
        detail="Your terminals keep running and take input."
      >
        <RovingLists className="flex min-h-0 flex-1 flex-col">
          <SidebarLists terminals={terminals} active={active} onOpen={onOpen} rail={rail} query={query} />
        </RovingLists>
      </RegionBoundary>
      <SidebarFooter rail={rail}>
        {rail ? (
          <SidebarFooterItem
            rail
            icon={<PanelLeftOpen aria-hidden />}
            label="Expand sidebar"
            onClick={onExpand ?? (() => setSize({ rail: false }))}
          />
        ) : null}
        <SidebarFooterItem
          rail={rail}
          icon={<Settings aria-hidden />}
          label="Settings"
          {...(update === null ? {} : { dot: "update ready" })}
          render={<Link to="/settings" />}
        />
        <SidebarFooterItem
          rail={rail}
          icon={<Plus aria-hidden />}
          label="Add machine"
          onClick={machines.openAddMachine}
        />
      </SidebarFooter>
      {drawer || railProp !== undefined ? null : (
        <SidebarEdge width={sidebarWidth} rail={rail} railWidth={railPx} onChange={setSize} onDragging={setDragging} />
      )}
    </aside>
  );
}
