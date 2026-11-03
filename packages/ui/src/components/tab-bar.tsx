import { Plus, X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { IconButton } from "./icon-button.tsx";
import { StatusIndicator, type AgentStatus } from "./status.tsx";

export interface WorkspaceTab {
  readonly id: string;
  readonly title: string;
  readonly icon?: ReactNode;
  readonly status?: AgentStatus;
}

export interface TabBarProps {
  readonly tabs: readonly WorkspaceTab[];
  readonly activeId: string;
  readonly onSelect?: (id: string) => void;
  readonly onClose?: (id: string) => void;
  readonly onNew?: () => void;
  /** The New tab shortcut as key chips, from the app's live binding; none when it is unbound. */
  readonly newTabKeys?: readonly string[];
  /** Before the tabs, e.g. the button that brings a hidden sidebar back where the sidebar was. */
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  readonly className?: string;
}

/** herdr-app's tab strip: raised pill for the active tab, status glyph instead of colour bars. */
export function TabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNew,
  newTabKeys,
  leading,
  trailing,
  className,
}: TabBarProps) {
  return (
    <div
      data-titlebar
      className={cn(
        "flex h-(--tabbar-height) shrink-0 items-center gap-1 border-b border-border bg-chrome px-2.5",
        className,
      )}
    >
      {leading}
      <div role="tablist" aria-label="Tabs" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          return (
            <div
              key={tab.id}
              className={cn(
                "group flex h-7 max-w-52 shrink-0 items-center gap-2 rounded-md border pr-1 pl-2.5 text-[0.8rem]",
                active
                  ? "border-border bg-raised text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-hover",
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onSelect?.(tab.id)}
                className="flex min-w-0 items-center gap-2 rounded-xs outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
              >
                {tab.icon}
                <span title={tab.title} className="truncate">
                  {tab.title}
                </span>
                {tab.status === undefined ? null : <StatusIndicator status={tab.status} className="size-3" />}
              </button>
              <IconButton
                label={`Close ${tab.title}`}
                icon={<X />}
                onClick={() => onClose?.(tab.id)}
                className={cn(
                  "size-5 [&_svg]:size-3",
                  !active && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                )}
              />
            </div>
          );
        })}
        <IconButton
          label="New tab"
          {...(newTabKeys === undefined ? {} : { keys: newTabKeys })}
          icon={<Plus />}
          onClick={onNew}
        />
      </div>
      {trailing}
    </div>
  );
}
