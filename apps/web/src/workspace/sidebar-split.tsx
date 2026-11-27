import { ScrollArea, cn } from "@doriface/ui";
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { clampShare, DEFAULT_AGENTS_SHARE, shareBounds } from "./layout.ts";
import { useAgentsShare } from "./layout-store.ts";

/** One arrow press moves the divider this many CSS px, as the sidebar edge's does. */
const STEP = 16;

export interface SidebarSplitProps {
  readonly spaces: ReactNode;
  readonly agents: ReactNode;
  /** When there are no agents to show, collapse the bottom pane to its compact header instead of holding a 40% void. */
  readonly agentsEmpty?: boolean;
}

/**
 * Spaces on top, Agents docked at the bottom, with herdr-app's divider between them: drag it, or focus it and use the
 * arrows (Home and End for the limits) to share the height; each section keeps a minimum, and a double-click resets.
 */
export function SidebarSplit({ spaces, agents, agentsEmpty = false }: SidebarSplitProps) {
  const [share, setShare] = useAgentsShare();
  const root = useRef<HTMLDivElement | null>(null);
  const [total, setTotal] = useState(0);
  const [active, setActive] = useState(false);
  useLayoutEffect(() => {
    const element = root.current;
    if (element === null) return undefined;
    setTotal(element.getBoundingClientRect().height);
    const observer = new ResizeObserver(() => setTotal(element.getBoundingClientRect().height));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const shown = total > 0 ? clampShare(share, total) : share;
  const bounds = shareBounds(total);
  const set = (next: number): void => setShare(clampShare(next, total));

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setActive(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!active || root.current === null) return;
    const box = root.current.getBoundingClientRect();
    set((box.bottom - event.clientY) / box.height);
  };
  const end = (): void => setActive(false);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = total > 0 ? STEP / total : 0;
    if (event.key === "ArrowUp") set(shown + step);
    else if (event.key === "ArrowDown") set(shown - step);
    else if (event.key === "Home") set(bounds.min);
    else if (event.key === "End") set(bounds.max);
    else return;
    event.preventDefault();
  };

  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col">
      <div data-sidebar-pane="spaces" className="flex min-h-0 flex-1 flex-col">
        <ScrollArea slot="spaces-list" className="flex-1">
          {spaces}
        </ScrollArea>
      </div>
      {agentsEmpty ? (
        <div data-sidebar-pane="agents" className="flex shrink-0 flex-col border-t border-sidebar-border pt-1.5">
          {agents}
        </div>
      ) : (
        <>
          <div
            role="separator"
            aria-label="Resize Spaces and Agents"
            aria-orientation="horizontal"
            aria-valuemin={Math.round(bounds.min * 100)}
            aria-valuemax={Math.round(bounds.max * 100)}
            aria-valuenow={Math.round(shown * 100)}
            aria-valuetext={`Agents ${Math.round(shown * 100)} percent`}
            tabIndex={0}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={end}
            onPointerCancel={end}
            onDoubleClick={() => setShare(DEFAULT_AGENTS_SHARE)}
            onKeyDown={onKeyDown}
            className={cn(
              "relative z-10 h-px shrink-0 cursor-row-resize touch-none bg-sidebar-border outline-none",
              "before:absolute before:inset-x-0 before:-inset-y-1 transition-colors duration-(--duration-micro)",
              "hover:bg-ring focus-visible:bg-ring",
              active && "bg-ring",
            )}
          />
          <div
            data-sidebar-pane="agents"
            className="flex min-h-0 flex-col pt-2"
            style={{ flex: `0 0 ${shown * 100}%` }}
          >
            <ScrollArea slot="agents-list" className="flex-1">
              {agents}
            </ScrollArea>
          </div>
        </>
      )}
    </div>
  );
}
