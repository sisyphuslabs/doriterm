import { cn } from "@doriface/ui";
import { Link } from "@tanstack/react-router";
import { Bot, LayoutGrid, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { usePendingUpdate } from "../update/update-store.ts";
import type { PhoneHomeTab } from "./phone-home-tab.ts";

const ITEM = cn(
  "flex min-h-(--control) min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-md text-xs text-muted-foreground",
  "outline-none transition-colors duration-(--duration-micro) ease-(--ease-out) active:bg-selected",
  "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring [&_svg]:size-5",
  "aria-[current=page]:font-semibold aria-[current=page]:text-foreground",
);

function TabFace({ icon, label }: { readonly icon: ReactNode; readonly label: string }) {
  return (
    <>
      <span aria-hidden className="relative flex">
        {icon}
      </span>
      <span>{label}</span>
    </>
  );
}

/**
 * The phone home's bottom tabs (#1387): Agents and Spaces swap the list in place, Settings opens its route. Monochrome
 * like a platform tab bar; the current tab is told by weight and `aria-current`, not by colour alone.
 */
export function PhoneTabBar({
  tab,
  onTab,
}: {
  readonly tab: PhoneHomeTab;
  readonly onTab: (next: PhoneHomeTab) => void;
}) {
  const update = usePendingUpdate();
  const item = (value: PhoneHomeTab, label: string, icon: ReactNode) => (
    <button
      type="button"
      className={ITEM}
      aria-current={tab === value ? "page" : undefined}
      onClick={() => onTab(value)}
    >
      <TabFace icon={icon} label={label} />
    </button>
  );
  return (
    <nav
      aria-label="Sections"
      data-phone-tab-bar
      className="flex shrink-0 items-stretch gap-1 border-t border-border bg-chrome px-2 pt-1 pb-[max(0.25rem,var(--safe-bottom))]"
    >
      {item("agents", "Agents", <Bot />)}
      {item("spaces", "Spaces", <LayoutGrid />)}
      <Link to="/settings" className={ITEM} aria-label={update === null ? "Settings" : "Settings, update ready"}>
        <TabFace
          label="Settings"
          icon={
            <>
              <Settings />
              {update === null ? null : (
                <span data-slot="settings-dot" className="absolute -top-0.5 -right-1 size-1.5 rounded-full bg-brand" />
              )}
            </>
          }
        />
      </Link>
    </nav>
  );
}
