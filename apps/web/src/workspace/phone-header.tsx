import { Button, StatusChip, StatusIndicator } from "@doriface/ui";
import { ChevronLeft } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { useFittedLines } from "./fit-lines.ts";
import { agentStatus } from "./attention.ts";
import { machineOf, type Session, spaceName, spaceOfAddress, terminalTitle } from "./model.ts";
import { useShown } from "./use-shown.ts";
import { useSpaceSelection } from "./space-selection.ts";
import { PhoneSessionSheet } from "./phone-session-sheet.tsx";

export interface PhoneHeaderProps {
  readonly terminal: Session;
  /** Every session, for the session sheet's next agent that needs you (#1467). */
  readonly terminals: readonly Session[];
  /** Its tab's own name; null when the tab has none, so the terminal's title names the screen. */
  readonly tabTitle: string | null;
  /** This machine's name, for a session on this machine: the place under the title always names the machine. */
  readonly host: string;
  /**
   * The space Back returns to, by name (it was opened from that space's screen); "" while that space is not read yet, so
   * Back is the chevron alone; null when Back goes to the agents.
   */
  readonly backTo: string | null;
  readonly onBack: () => void;
  /** Opens another session, as the session sheet's "next agent that needs you" does. */
  readonly onOpen: (address: string) => void;
  /** One more header control before the switch, such as the mic (#227). */
  readonly action?: ReactNode;
}

/**
 * The phone terminal's header: Back, labelled with where it goes, then the tab and its state and where it is. Switching
 * tabs and the tab's place (n/m) live in the bottom tabs bar alone, one strip as in herdr-app (#466); how many agents
 * need the person is the agents list's to say, not this session's header.
 */
export function PhoneHeader({ terminal, terminals, host, tabTitle, backTo, onBack, onOpen, action }: PhoneHeaderProps) {
  // The tab's own name, else the terminal's title: an agent's or a program's name, never the tab's place among its space's.
  const [now = terminal] = useShown([terminal]);
  const title = tabTitle ?? terminalTitle(now);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleLines = useFittedLines(heading, title);
  const machine = machineOf(terminal.address);
  // Where it is: the layout space whose tab shows it (#404), else where it runs.
  const { spaces } = useSpaceSelection();
  const space = spaceOfAddress(spaces, terminal.address)?.name ?? spaceName(terminal);
  const where = `${machine ?? host} · ${space}`;
  return (
    <header
      data-titlebar
      className="flex min-h-12 shrink-0 items-center gap-1 border-b border-border bg-chrome pt-[env(safe-area-inset-top)] pr-1.5 pl-[var(--titlebar-inset-start,0.375rem)]"
    >
      <Button
        variant="ghost"
        aria-label={backTo === null ? "Back to agents" : backTo === "" ? "Back" : `Back to ${backTo}`}
        className="max-w-[7.5rem] min-w-11 shrink-0 gap-0.5 px-1.5 text-foreground [&>span]:min-w-0"
        onClick={onBack}
      >
        <ChevronLeft aria-hidden />
        {/* Under 360 px the chevron alone: the title keeps the row (its accessible name still says where Back goes). */}
        {backTo === "" ? null : <span className="min-w-0 truncate max-[359px]:hidden">{backTo ?? "Agents"}</span>}
      </Button>
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
        <p title={where} className="min-w-0 truncate text-xs leading-tight text-muted-foreground">
          {where}
        </p>
      </div>
      {/* `contents`: an empty slot draws no box and takes no gap; a control in it is one more header item. */}
      <span data-header-action className="contents">
        {action}
      </span>
      <PhoneSessionSheet terminal={terminal} terminals={terminals} title={title} where={where} onOpen={onOpen} />
    </header>
  );
}
