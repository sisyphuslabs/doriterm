import { ChevronDown, Monitor, Plus, Server } from "lucide-react";
import type { ButtonHTMLAttributes, Ref } from "react";
import { cn } from "../lib/cn.ts";
import { IconButton } from "./icon-button.tsx";

export interface MachineHeaderProps {
  readonly name: string;
  /** The machine this client is connected to. */
  readonly local: boolean;
  /** Its state in words ("this machine", "connecting", "offline", "needs login"). */
  readonly state: string;
  /** Says the state in the blocked ink: offline or needs login. */
  readonly alarm?: boolean;
  /** The tabs of the spaces listed under it: the sum of their rows' counts. */
  readonly tabs: number;
  /** Its spaces are folded away under the header. */
  readonly collapsed?: boolean;
  /**
   * Folds or unfolds its spaces. Without it there is no chevron, but its slot stays reserved (as while a filter takes
   * the toggle away, #850), so the header's other parts do not move by its width (#1158).
   */
  readonly onToggle?: () => void;
  readonly selected?: boolean;
  /** Opens its first terminal; left out when it has none (the header stays a stop for its action). */
  readonly onOpen?: () => void;
  /** Starts a new space on it; disabled while it is not connected. */
  readonly onNewSpace: () => void;
  readonly connected: boolean;
  readonly rail?: boolean;
  readonly className?: string;
  /** More for the row's button, as a list that reorders its machines needs: a ref, keys, focus tracking. */
  readonly buttonProps?: ButtonHTMLAttributes<HTMLButtonElement> & { readonly ref?: Ref<HTMLButtonElement> };
}

/**
 * The head of one machine's spaces, shown once more than one machine is known: icon, name, state, tab count, then
 * herdr-app's New space on <name>, status dot and fold chevron. The row is the group's first stop; the actions follow it
 * with ArrowRight.
 */
export function MachineHeader({
  name,
  local,
  state,
  alarm = false,
  tabs,
  collapsed = false,
  onToggle,
  selected = false,
  onOpen,
  onNewSpace,
  connected,
  rail = false,
  className,
  buttonProps,
}: MachineHeaderProps) {
  const Icon = local ? Monitor : Server;
  // With no terminal to open only the icon dims, in a disabled ghost icon's ink (3:1), never a fade (#1243): the name
  // and count stay as legible as the state label.
  const quiet = onOpen === undefined && "text-muted-foreground/72";
  return (
    <div className={cn("group flex h-(--row) min-w-0 items-center rounded-md", selected && "bg-selected", className)}>
      <button
        {...buttonProps}
        type="button"
        data-machine-header={name}
        aria-current={selected ? "true" : undefined}
        aria-disabled={onOpen === undefined || undefined}
        {...(rail ? { "aria-label": `${name}, ${state}` } : {})}
        // The state label gives way first and can end in an ellipsis: the header's title reads it whole (#576), as the
        // rail's does. The name keeps its own title, so a row's one titled span stays its name.
        title={`${name}, ${state}`}
        onClick={() => onOpen?.()}
        className={cn(
          "flex h-full min-w-0 flex-1 items-center gap-2 rounded-md text-left text-xs font-medium text-muted-foreground outline-none",
          "hover:bg-hover focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring aria-disabled:cursor-default aria-disabled:hover:bg-transparent",
          rail ? "justify-center px-0" : "px-2",
        )}
      >
        <Icon aria-hidden className={cn("size-3.5 shrink-0", quiet)} />
        {rail ? null : (
          <>
            {/* The name keeps the row: it starts at its full width, and the state label gives way first. */}
            <span title={name} className="min-w-0 grow truncate">
              {name}
            </span>
            <span
              className={cn("min-w-0 shrink-999 truncate text-2xs font-normal", alarm && "text-status-blocked-text")}
            >
              {state}
            </span>
            {/* At least one digit wide, so single digits keep their column, and as wide as more digits need (#878). */}
            <span data-numeric aria-label={`${tabs} tabs`} className="min-w-4 shrink-0 text-right whitespace-nowrap">
              {tabs}
            </span>
          </>
        )}
      </button>
      {rail ? null : (
        <IconButton
          label={`New space on ${name}`}
          icon={<Plus />}
          disabled={!connected}
          onClick={onNewSpace}
          className="size-6 text-muted-foreground"
        />
      )}
      {rail ? null : (
        <span
          aria-hidden
          data-machine-dot={connected ? "online" : "offline"}
          className={cn(
            // On a coarse pointer the dot keeps the buttons on its sides 20 px apart, so their 44 px hit areas do not meet.
            "mx-1.5 size-1.5 shrink-0 rounded-full coarse:mx-2",
            connected ? "bg-online" : alarm ? "bg-status-blocked" : "bg-status-unknown",
          )}
        />
      )}
      {rail ? null : onToggle === undefined ? (
        // A filter takes the toggle away (#850); its slot stays reserved so New space and the dot beside it do not move
        // by its width (#1158).
        <span aria-hidden className="mr-1 size-6 shrink-0" />
      ) : (
        <IconButton
          label={`${collapsed ? "Expand" : "Collapse"} ${name}`}
          aria-expanded={!collapsed}
          icon={
            <ChevronDown
              className={cn(
                "transition-transform duration-(--duration-micro) motion-reduce:transition-none",
                collapsed && "-rotate-90",
              )}
            />
          }
          onClick={onToggle}
          className="mr-1 size-6 text-muted-foreground"
        />
      )}
    </div>
  );
}
