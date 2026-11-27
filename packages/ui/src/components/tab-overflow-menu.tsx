import { Check, ChevronDown } from "lucide-react";
import { IconButton } from "./icon-button.tsx";
import { Menu, MenuItem } from "./menu.tsx";
import { StatusIndicator } from "./status.tsx";
import type { WorkspaceTab } from "./tab-item.tsx";

/** Overflow menu listing every tab with its status glyph and active mark. */
export function TabOverflowMenu({
  tabs,
  activeId,
  onSelect,
}: {
  readonly tabs: readonly WorkspaceTab[];
  readonly activeId: string;
  readonly onSelect: ((id: string) => void) | undefined;
}) {
  return (
    <Menu align="end" trigger={<IconButton label="All tabs" icon={<ChevronDown />} />}>
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <MenuItem
            key={tab.id}
            aria-current={active ? "true" : undefined}
            {...(tab.status === undefined
              ? {}
              : {
                  icon: (
                    <StatusIndicator
                      status={tab.status}
                      {...(tab.status === "working" ? { className: "[&_svg]:text-status-working" } : {})}
                    />
                  ),
                })}
            onClick={() => onSelect?.(tab.id)}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{tab.title}</span>
              {active ? (
                <span className="shrink-0 [&_svg]:text-foreground">
                  <Check aria-hidden />
                </span>
              ) : null}
            </span>
          </MenuItem>
        );
      })}
    </Menu>
  );
}
