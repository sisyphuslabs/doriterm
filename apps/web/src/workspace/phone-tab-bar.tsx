import { Badge, cn } from "@doriface/ui";
import { Link } from "@tanstack/react-router";
import { Bot, FolderOpen, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { usePendingUpdate } from "../update/update-store.ts";
import { agentStatus } from "./attention.ts";
import type { Session } from "./model.ts";
import type { PhoneSection } from "./phone-route.ts";

const ITEM = cn(
  "flex min-h-(--control) min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-md text-xs text-muted-foreground",
  "outline-none hover:text-foreground active:bg-selected [&_svg]:size-5",
  "focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring",
  "aria-[current=page]:font-semibold aria-[current=page]:text-foreground",
);

function TabFace({
  icon,
  label,
  mark,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly mark?: ReactNode;
}) {
  return (
    <>
      <span aria-hidden className="relative flex h-6 w-10 items-end justify-center">
        {icon}
        {mark}
      </span>
      <span aria-hidden>{label}</span>
    </>
  );
}

/** How many agents need the person: the live ones blocked on a question, the Agents list's Needs you. */
export const needsYouCount = (terminals: readonly Session[]): number =>
  terminals.filter((terminal) => terminal.state === "live" && agentStatus(terminal) === "blocked").length;

/**
 * The phone lists' bottom tabs: Agents and Spaces show their lists, Settings opens its route. Monochrome as a platform tab
 * bar is; the current tab is told by weight and `aria-current`, and Agents carries how many agents need the person.
 */
export function PhoneTabBar({
  section,
  terminals,
  onSection,
}: {
  readonly section: PhoneSection;
  readonly terminals: readonly Session[];
  readonly onSection: (next: PhoneSection) => void;
}) {
  const update = usePendingUpdate();
  const needsYou = needsYouCount(terminals);
  const tab = (value: PhoneSection, label: string, icon: ReactNode, name: string, mark?: ReactNode) => (
    <button
      type="button"
      className={ITEM}
      aria-label={name}
      aria-current={section === value ? "page" : undefined}
      onClick={() => onSection(value)}
    >
      <TabFace icon={icon} label={label} mark={mark} />
    </button>
  );
  return (
    <nav
      aria-label="Sections"
      className="flex shrink-0 items-stretch gap-1 border-t border-border bg-chrome px-2 pt-1 pb-[max(0.25rem,var(--safe-bottom))]"
    >
      {tab(
        "agents",
        "Agents",
        <Bot />,
        needsYou === 0 ? "Agents" : `Agents, ${needsYou} need${needsYou === 1 ? "s" : ""} you`,
        needsYou === 0 ? undefined : (
          <Badge tone="blocked" className="absolute top-0 right-0 h-4 min-w-4 justify-center rounded-full px-1">
            <span data-slot="tab-badge" data-numeric>
              {needsYou}
            </span>
          </Badge>
        ),
      )}
      {tab("spaces", "Spaces", <FolderOpen />, "Spaces")}
      <Link to="/settings" className={ITEM} aria-label={update === null ? "Settings" : "Settings, update ready"}>
        <TabFace
          label="Settings"
          icon={<Settings />}
          mark={
            update === null ? undefined : (
              <span data-slot="settings-dot" className="absolute top-0.5 right-2 size-1.5 rounded-full bg-brand" />
            )
          }
        />
      </Link>
    </nav>
  );
}
