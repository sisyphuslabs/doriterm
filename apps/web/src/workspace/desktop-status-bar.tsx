import { Button, Kbd, StatusBar, StatusBarItem } from "@doriface/ui";
import { Monitor } from "lucide-react";
import { useActionKeys } from "../keys/use-action-keys.ts";
import { agentStatus, nextNeedingYou } from "./attention.ts";
import { machineOf, type Session, spaceName } from "./model.ts";
import { HistoryGapStatus } from "./history-gap-status.tsx";
import { ConnectedStatus, ConnectionPathItem, ReconnectStatus, useConnectionNotice } from "./reconnect-status.tsx";

export interface DesktopStatusBarProps {
  readonly terminals: readonly Session[];
  /** The live terminals on reachable machines: what the bar counts. */
  readonly live: readonly Session[];
  /** False until the core has listed its terminals; the count would read 0 until then. */
  readonly loaded: boolean;
  readonly focusedAddress: string | null;
  readonly focusedTerminal: Session | undefined;
  /** The focused terminal's machine; undefined with nothing focused (#2531). */
  readonly focusedMachine: string | undefined;
  /** Opens a terminal as the sidebar's row does. */
  readonly onOpen: (address: string) => void;
  readonly onPalette: () => void;
}

/** The desktop's footer: where the focused terminal is, how many there are and who needs you, and the palette. */
export function DesktopStatusBar(props: DesktopStatusBarProps) {
  const { terminals, live, loaded, focusedAddress, focusedTerminal, focusedMachine, onOpen, onPalette } = props;
  const paletteKeys = useActionKeys("app.palette");
  const blocked = live.filter((terminal) => agentStatus(terminal) === "blocked").length;
  const next = nextNeedingYou(terminals, focusedAddress);
  // Until the connection is back nothing is known to be missing yet: the bar says it reconnects, as the phone line does.
  const reconnecting = useConnectionNotice() !== null;
  return (
    <StatusBar
      start={
        <>
          {/* A terminal on another machine shows its full hc address (build-box/t3): what hc commands take. */}
          {focusedMachine === undefined ? null : (
            <span data-status-machine className="flex min-w-0">
              <span className="sr-only">Machine: </span>
              <StatusBarItem icon={<Monitor aria-hidden />}>
                {focusedAddress !== null && machineOf(focusedAddress) !== undefined ? focusedAddress : focusedMachine}
              </StatusBarItem>
            </span>
          )}
          {focusedTerminal === undefined ? null : (
            // The space gives way first, so a long name never pushes the terminal count out of the bar.
            <span data-status-space className="-ml-2.5 flex max-w-48 min-w-0 items-center gap-1.5">
              {/* One breadcrumb with the machine (#1456): the bar's gap closes up and a separator a reader skips joins them. */}
              <span aria-hidden data-status-place-separator="" className="shrink-0">
                ›
              </span>
              <span className="sr-only">Space: </span>
              <StatusBarItem>{spaceName(focusedTerminal)}</StatusBarItem>
            </span>
          )}
          {loaded ? (
            <span className="flex shrink-0 items-center gap-1">
              <StatusBarItem>{`${live.length} ${live.length === 1 ? "terminal" : "terminals"}`}</StatusBarItem>
              {/* Beside the words, not inside their ellipsis box: the button's hit area would widen it (#1448). */}
              {next === null ? null : (
                <>
                  <span aria-hidden>·</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    title="Open the next terminal that needs you"
                    onClick={() => onOpen(next)}
                    className="h-5 px-1 text-xs text-status-blocked-text hover:text-status-blocked-text"
                  >
                    {blocked} needs you
                  </Button>
                </>
              )}
            </span>
          ) : null}
          <ReconnectStatus />
          <ConnectedStatus />
          {reconnecting ? null : <HistoryGapStatus address={focusedAddress} />}
          <ConnectionPathItem />
        </>
      }
      end={
        <Button
          variant="ghost"
          size="sm"
          onClick={onPalette}
          className="h-5 gap-1.5 px-1 text-xs text-muted-foreground"
        >
          {paletteKeys === undefined ? null : <Kbd keys={paletteKeys} />}
          Commands
        </Button>
      }
    />
  );
}
