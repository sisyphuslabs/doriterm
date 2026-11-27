import type { HcConnection } from "@doriface/client";
import { terminalSpaceName } from "@doriface/protocol";
import { Button, NeedsYouPill, StatusChip, StatusIndicator } from "@doriface/ui";
import { ChevronLeft } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { useFittedLines } from "./fit-lines.ts";
import { agentStatus, nextNeedingYou, waitingBesides } from "./attention.ts";
import { machineOf, type Session, spaceOfAddress, terminalTitle } from "./model.ts";
import { useShown } from "./use-shown.ts";
import { useSpaceSelection } from "./space-selection.ts";
import { PhoneSessionSheet } from "./phone-session-sheet.tsx";
import { backWithMotion } from "./phone-back-motion.ts";
import { readoutText, usePinchReadout } from "../terminal/pinch-readout.ts";
import { PhoneTerminalLine } from "./phone-terminal-line.tsx";

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
  /** The workspace's connection while it is open, so the second line can say when the terminal's machine is away. */
  readonly connection?: HcConnection | undefined;
}

/**
 * The phone terminal's header: Back, labelled with where it goes, then the tab and its state and where it is, plus a
 * compact count of the other agents that need you so a person can jump straight to them without going back to the list
 * (owner decision 2026-11-26, #2863). Switching tabs and the tab's place (n/m) stay in the bottom tabs bar alone, one
 * strip as in herdr-app (#466).
 */
export function PhoneHeader({
  terminal,
  terminals,
  host,
  tabTitle,
  backTo,
  onBack,
  onOpen,
  action,
  connection,
}: PhoneHeaderProps) {
  // The tab's own name, else the terminal's title: an agent's or a program's name, never the tab's place among its space's.
  const [now = terminal] = useShown([terminal]);
  const title = tabTitle ?? terminalTitle(now);
  const heading = useRef<HTMLHeadingElement>(null);
  // While the needs-you pill takes its share of the row, the title keeps one line and ends in an ellipsis: the pill must
  // never make the header taller, or the terminal loses a row on a phone (#2865). Without it, two lines as before.
  const waiting = waitingBesides(terminals, terminal.address);
  const titleLines = useFittedLines(heading, title, waiting > 0 ? 1 : 2);
  const machine = machineOf(terminal.address);
  // Where it is: the layout space whose tab shows it (#404), else where it runs.
  const { spaces } = useSpaceSelection();
  const space = spaceOfAddress(spaces, terminal.address)?.name ?? terminalSpaceName(terminal);
  // While a pinch moves, the line under the title reads the size and grid instead; nothing is drawn over the terminal.
  const pinch = usePinchReadout(terminal.address);
  const where = pinch === null ? `${machine ?? host} · ${space}` : readoutText(pinch);
  return (
    <header
      data-titlebar
      data-phone-top
      className="flex min-h-12 shrink-0 items-center gap-1 border-b border-border bg-chrome pt-[env(safe-area-inset-top)] pr-1.5 pl-[var(--titlebar-inset-start,0.375rem)]"
    >
      <Button
        variant="ghost"
        aria-label={backTo === null ? "Back to agents" : backTo === "" ? "Back" : `Back to ${backTo}`}
        className="max-w-[7.5rem] min-w-11 shrink-0 gap-0.5 px-1.5 text-foreground [&>span]:min-w-0"
        onClick={(event) => backWithMotion(event.currentTarget, onBack)}
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
        {/* What the link is doing is said in this same line, at its height, so the terminal keeps its rows (#2853). */}
        <PhoneTerminalLine
          address={terminal.address}
          connection={connection}
          fallback={
            <p
              title={where}
              data-pinch-readout={pinch === null ? undefined : ""}
              className="min-w-0 truncate text-xs leading-tight text-muted-foreground tabular-nums"
            >
              {where}
            </p>
          }
        />
      </div>
      <NeedsYouPill
        count={waiting}
        compact
        onOpen={() => {
          const next = nextNeedingYou(terminals, terminal.address);
          if (next !== null && next !== terminal.address) onOpen(next);
        }}
      />
      {/* `contents`: an empty slot draws no box and takes no gap; a control in it is one more header item. */}
      <span data-header-action className="contents">
        {action}
      </span>
      <PhoneSessionSheet terminal={terminal} terminals={terminals} title={title} where={where} onOpen={onOpen} />
    </header>
  );
}
