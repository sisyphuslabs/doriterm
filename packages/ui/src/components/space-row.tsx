import { Folder } from "lucide-react";
import { cn } from "../lib/cn.ts";
import { StatusIndicator, type AgentStatus } from "./status.tsx";

export interface Space {
  readonly id: string;
  readonly name: string;
  readonly machine?: string;
  /** Number of tabs. */
  readonly tabs: number;
  /** The most urgent agent status inside, if any. */
  readonly attention?: AgentStatus;
}

export interface SpaceRowProps {
  readonly space: Space;
  readonly selected?: boolean;
  readonly onSelect?: (id: string) => void;
  readonly className?: string;
}

/** A workspace (herdr space) in the sidebar: folder, name, its most urgent agent, tab count. */
export function SpaceRow({ space, selected = false, onSelect, className }: SpaceRowProps) {
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect?.(space.id)}
      className={cn(
        "flex h-(--row) w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-left text-sm text-foreground outline-none",
        "hover:bg-hover focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring",
        selected && "bg-selected",
        className,
      )}
    >
      <Folder aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span title={space.name} className="min-w-0 flex-1 truncate">
        {space.name}
      </span>
      {space.machine === undefined ? null : (
        <span title={space.machine} className="min-w-0 max-w-[50%] truncate text-2xs text-muted-foreground">
          {space.machine}
        </span>
      )}
      {space.attention === undefined ? null : <StatusIndicator status={space.attention} className="size-3" />}
      <span
        data-numeric
        aria-label={`${space.tabs} tabs`}
        className="w-4 shrink-0 text-right text-xs text-muted-foreground"
      >
        {space.tabs}
      </span>
    </button>
  );
}
