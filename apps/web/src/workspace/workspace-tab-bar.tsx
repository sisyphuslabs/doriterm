import { TabBar, type TabBarProps, type TabDragOut } from "@doriface/ui";
import { useMemo, useRef } from "react";
import { useStripDropActive, useTabStripDropTarget, useTerminalDragSession } from "./terminal-drag.tsx";
import type { Layout } from "./use-layout.ts";

export interface WorkspaceTabBarProps extends Omit<TabBarProps, "barRef" | "onDragOut" | "dropActive"> {
  readonly layout: Layout;
}

/**
 * The desktop tab strip wired to the shared terminal drag context: dragging a tab past the strip's lower edge drives
 * TerminalDragProvider so the active tab's panes preview and take the drop, and dragging a pane header onto the strip
 * highlights it and detaches that pane into a new tab.
 */
export function WorkspaceTabBar({ layout, tabs, ...props }: WorkspaceTabBarProps) {
  const bar = useRef<HTMLDivElement>(null);
  const session = useTerminalDragSession();
  const dropActive = useStripDropActive();
  useTabStripDropTarget(bar);

  const latest = useRef({ layout, tabs, session });
  latest.current = { layout, tabs, session };

  const dragOut = useMemo<TabDragOut | undefined>(() => {
    if (session === null) return undefined;
    const itemOf = (id: string): { readonly address: string; readonly name: string } | null => {
      const address = latest.current.layout.focusedTerminalOf?.(id) ?? null;
      if (address === null) return null;
      const name = latest.current.tabs.find((each) => each.id === id)?.title ?? address;
      return { address, name };
    };
    return {
      move: (id, x, y) => {
        const item = itemOf(id);
        if (item === null) return false;
        latest.current.session?.move(item.address, item.name, x, y);
        return true;
      },
      drop: (id, x, y) => {
        const item = itemOf(id);
        if (item === null) latest.current.session?.cancel();
        else latest.current.session?.drop(item.address, x, y);
      },
      cancel: () => latest.current.session?.cancel(),
    };
  }, [session]);

  return (
    <TabBar
      {...props}
      tabs={tabs}
      barRef={bar}
      {...(dragOut === undefined ? {} : { onDragOut: dragOut })}
      dropActive={dropActive}
    />
  );
}
