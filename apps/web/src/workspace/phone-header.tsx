import { IconButton, StatusChip, StatusIndicator, cn } from "@doriface/ui";
import { ChevronLeft } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { useFittedLines } from "./fit-lines.ts";
import { agentStatus } from "./attention.ts";
import { agentCounts, machineOf, type Session, spaceName, terminalTitle } from "./model.ts";
import { useSpaceSelection } from "./space-selection.ts";
import { PhoneSessionSheet } from "./phone-session-sheet.tsx";

export interface PhoneHeaderProps {
  readonly terminal: Session;
  readonly terminals: readonly Session[];
  /** Its tab as the desktop strip reads it (its name, else its number); null when it is in no tab. */
  readonly tabTitle: string | null;
  readonly onBack: () => void;
  /** Opens another session, as the session sheet's "next agent that needs you" does. */
  readonly onOpen: (address: string) => void;
  /** One more header control before the switch, such as the mic (#227). */
  readonly action?: ReactNode;
}

const COUNTED = [
  { status: "done", word: "done" },
  { status: "working", word: "working" },
  { status: "idle", word: "idle" },
] as const;

/**
 * The phone terminal's header: its tab and state, where it is, the agent counts. Switching tabs and the tab's place (n/m)
 * live in the bottom tabs bar alone, one strip as in herdr-app (#466).
 */
export function PhoneHeader({ terminal, terminals, tabTitle, onBack, onOpen, action }: PhoneHeaderProps) {
  // The tab, as the desktop strip names it (#466 ruling A); a terminal in no tab has only its own title.
  const title = tabTitle ?? terminalTitle(terminal);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleLines = useFittedLines(heading, title);
  const machine = machineOf(terminal.address);
  // Where it is: the layout space whose tab shows it (#404), else where it runs.
  const { spaces } = useSpaceSelection();
  const space = spaces.find((each) => each.addresses.includes(terminal.address))?.name ?? spaceName(terminal);
  const where = machine === undefined ? space : `${machine} · ${space}`;
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
      <PhoneSessionSheet
        terminal={terminal}
        terminals={terminals}
        title={terminalTitle(terminal)}
        where={where}
        onOpen={onOpen}
      />
    </header>
  );
}
