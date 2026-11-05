import { AgentRow, IconButton, Sheet, SidebarSection, StatusChip, StatusIndicator, cn } from "@doriface/ui";
import { ArrowLeftRight, ChevronLeft } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { useFittedLines } from "./fit-lines.ts";
import {
  agentCounts,
  agentStatus,
  machineOf,
  type Session,
  spaceId,
  spaceName,
  tabPosition,
  terminalTitle,
  toAgent,
  toSpaces,
} from "./model.ts";
import { SessionMenu } from "./session-menu.tsx";
import { useNow } from "./use-now.ts";

export interface PhoneHeaderProps {
  readonly terminal: Session;
  readonly terminals: readonly Session[];
  readonly onBack: () => void;
  readonly onOpen: (address: string) => void;
  /** One more header control before the switch, such as the mic (#227). */
  readonly action?: ReactNode;
}

const COUNTED = [
  { status: "done", word: "done" },
  { status: "working", word: "working" },
  { status: "idle", word: "idle" },
] as const;

/** The phone terminal's header, after herdr-app's: name and state, where it is (n/m), the agent counts, a switch. */
export function PhoneHeader({ terminal, terminals, onBack, onOpen, action }: PhoneHeaderProps) {
  const title = terminalTitle(terminal);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleLines = useFittedLines(heading, title);
  const machine = machineOf(terminal.address);
  const where = machine === undefined ? spaceName(terminal) : `${machine} · ${spaceName(terminal)}`;
  const position = tabPosition(terminals, terminal.address);
  const counts = agentCounts(terminals);
  return (
    <header
      data-titlebar
      className="flex min-h-12 shrink-0 items-center gap-1 border-b border-border bg-chrome pt-[env(safe-area-inset-top)] pr-1.5 pl-[var(--titlebar-inset-start,0.375rem)]"
    >
      <IconButton label="Back to agents" icon={<ChevronLeft />} size="md" onClick={onBack} />
      {/* A container: the status chip shows its word only where the title keeps a readable share of the row (#479). */}
      <div className="@container flex min-w-0 flex-1 flex-col py-1">
        <div className="flex min-w-0 items-start gap-2">
          {/*
            The title names the screen: it takes the row and a second line, broken between words, before it ends in an
            ellipsis (fitted in its own font, never cut by its box); whole in its tooltip and its accessible name (aria-label).
          */}
          <h1
            ref={heading}
            title={title}
            aria-label={title}
            className="min-w-0 flex-1 overflow-hidden text-base leading-tight font-semibold text-ellipsis whitespace-pre text-foreground"
          >
            <span data-title-lines>{titleLines.join("\n")}</span>
          </h1>
          <StatusChip status={agentStatus(terminal)} className="hidden @min-[22rem]:inline-flex" />
          <StatusIndicator status={agentStatus(terminal)} className="mt-1 size-3.5 shrink-0 @min-[22rem]:hidden" />
        </div>
        {/* Under text spacing the counts wrap to a line of their own before the place gives up its last letters. */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs leading-tight text-muted-foreground">
          <p title={where} className="min-w-0 grow basis-8 truncate">
            {where}
          </p>
          {position === undefined ? null : (
            <span data-tab-position data-numeric className="shrink-0">
              <span aria-hidden>{`${position.index}/${position.count}`}</span>
              <span className="sr-only">{`Tab ${position.index} of ${position.count}`}</span>
            </span>
          )}
          <span data-agent-counts data-numeric className="ml-auto flex shrink-0 items-center gap-1.5">
            {COUNTED.map(({ status, word }, index) => (
              <span key={status} className="inline-flex items-center gap-0.5">
                <StatusIndicator
                  status={status}
                  decorative
                  className={cn("size-3", counts[status] === 0 && "[&_svg]:animate-none")}
                />
                {counts[status]}
                <span className="sr-only">{index === COUNTED.length - 1 ? ` ${word}` : ` ${word}, `}</span>
              </span>
            ))}
          </span>
        </div>
      </div>
      {/* `contents`: an empty slot draws no box and takes no gap; a control in it is one more header item. */}
      <span data-header-action className="contents">
        {action}
      </span>
      <SpaceSwitcher terminals={terminals} active={terminal.address} onOpen={onOpen} />
      <SessionMenu address={terminal.address} title={title} placement="header" />
    </header>
  );
}

/** A bottom sheet of every space with its tabs; picking a tab opens it on the phone. */
function SpaceSwitcher(props: {
  readonly terminals: readonly Session[];
  readonly active: string;
  readonly onOpen: (address: string) => void;
}) {
  const { terminals, active, onOpen } = props;
  const [open, setOpen] = useState(false);
  const now = useNow();
  const pick = (address: string): void => {
    setOpen(false);
    onOpen(address);
  };
  return (
    <Sheet
      title="Spaces"
      side="bottom"
      open={open}
      onOpenChange={setOpen}
      trigger={<IconButton label="Switch space or tab" icon={<ArrowLeftRight />} size="md" />}
    >
      <div className="flex flex-col gap-4">
        {toSpaces(terminals).map((space) => (
          <SidebarSection
            key={space.id}
            title={space.machine === undefined ? space.name : `${space.machine} · ${space.name}`}
            count={space.tabs}
          >
            {terminals
              .filter((entry) => entry.state === "live" && spaceId(entry) === space.id)
              .map((entry) => (
                <AgentRow
                  key={entry.address}
                  agent={toAgent(entry, now)}
                  selected={entry.address === active}
                  onSelect={pick}
                />
              ))}
          </SidebarSection>
        ))}
      </div>
    </Sheet>
  );
}
