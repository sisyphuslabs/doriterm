import type { HcConnection } from "@doriface/client";
import { cn, ContextMenu, IconButton, skipMenuHandler, skipTouchMenu } from "@doriface/ui";
import { Columns2, Maximize2, Minimize2, Rows2, X } from "lucide-react";
import type { Axis } from "@doriface/protocol/layout";
import { useActionKeys } from "../keys/use-action-keys.ts";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { ApprovalOverlay } from "../approval/approval-overlay.tsx";
import { RegionBoundary } from "../crash/region-boundary.tsx";
import type { TerminalEnd } from "../terminal/terminal-end.ts";
import type { TerminalPort } from "../terminal/terminal-port.ts";
import { TerminalView } from "../terminal/terminal-view.tsx";
import { useMachineLine } from "../terminal/use-machine-line.ts";
import { MachineOffline } from "./machine-offline.tsx";
import { machineOf, type Session, terminalTitle } from "./model.ts";
import { picksPane } from "./pane-focus.ts";
import { menuReturnsFocus, SessionMenuItems } from "./session-menu.tsx";

export interface PaneProps {
  readonly connection: HcConnection;
  readonly terminal: Session;
  readonly focused: boolean;
  /** This screen asked for this pane: its terminal takes the keyboard as it starts (#332). */
  readonly claimed: boolean;
  /** True when the tab holds more than one pane: unfocused-split-opacity dims only those, and each gets a header. */
  readonly split: boolean;
  readonly onFocus: () => void;
  readonly onEnd: (address: string, end: TerminalEnd) => void;
  readonly zoomed: boolean;
  readonly onSplit: (axis: Axis) => void;
  readonly onZoom: () => void;
  readonly onClose: () => void;
  /** The view showed that its program had already ended when it attached: there is no terminal left to type into. */
  readonly onEnded: (address: string, pid: number | null) => void;
  /** The view's input path, for input from outside the pane (dictation); null once the view unmounts. */
  readonly onPort: (port: TerminalPort | null) => void;
  /** Docked under the terminal, inside the card: the voice strip while this pane is dictated into. */
  readonly dock?: ReactNode;
  /** Starts dragging this pane by its header to another place in the tab; absent where the pane cannot move. */
  readonly onGrab?: ((event: ReactPointerEvent<HTMLElement>) => void) | undefined;
}

/** herdr-app's pane header buttons, each with its shortcut in the tooltip. */
function PaneButtons({
  zoomed,
  onSplit,
  onZoom,
  onClose,
}: Pick<PaneProps, "zoomed" | "onSplit" | "onZoom" | "onClose">) {
  const right = useActionKeys("pane.split:right");
  const down = useActionKeys("pane.split:down");
  const zoom = useActionKeys("pane.zoom");
  const close = useActionKeys("pane.close");
  const small = "size-6 [&_svg:not([data-slot=spinner])]:size-3.5";
  return (
    <span className="ml-auto flex shrink-0 items-center">
      <IconButton
        label="Split right"
        icon={<Columns2 />}
        className={small}
        {...(right === undefined ? {} : { keys: right })}
        onClick={() => onSplit("row")}
      />
      <IconButton
        label="Split down"
        icon={<Rows2 />}
        className={small}
        {...(down === undefined ? {} : { keys: down })}
        onClick={() => onSplit("column")}
      />
      <IconButton
        label={zoomed ? "Show every pane" : "Zoom pane"}
        icon={zoomed ? <Minimize2 /> : <Maximize2 />}
        className={small}
        pressed={zoomed}
        {...(zoom === undefined ? {} : { keys: zoom })}
        onClick={onZoom}
      />
      <IconButton
        label="Close pane"
        icon={<X />}
        className={small}
        {...(close === undefined ? {} : { keys: close })}
        onClick={onClose}
      />
    </span>
  );
}

/**
 * A terminal card. A tab's only pane has no title bar: its tab names it, the status bar says where it runs, and the
 * tab strip carries its session actions. Inside a split each pane gets a slim header naming its terminal, as herdr-app
 * frames panes only once a tab is split, since the tab can name only one of them.
 */
export function Pane(props: PaneProps) {
  const {
    connection,
    terminal,
    focused,
    claimed,
    split,
    zoomed,
    onFocus,
    onEnd,
    onEnded,
    onPort,
    dock,
    onSplit,
    onZoom,
    onClose,
    onGrab,
  } = props;
  const title = terminalTitle(terminal);
  const machine = machineOf(terminal.address);
  // Watched for every pane on screen, so a drop is noticed within a line read, focused or not.
  const away = useMachineLine(connection, terminal.address, terminal.offline !== true);
  return (
    <section
      aria-label={`${title} terminal`}
      onFocusCapture={(event) => {
        const starting = event.target instanceof Element && event.target.closest('[data-ready="false"]') !== null;
        if (picksPane(starting, focused)) onFocus();
      }}
      data-split={split}
      data-focused={focused}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card [&_.wterm]:transition-opacity [&_.wterm]:duration-(--duration-micro)"
    >
      {split ? (
        <ContextMenu
          // A split pane's header names its session, so its right-click opens the session's menu (#699), and a dialog an
          // item opened keeps the keyboard as the "..." menu leaves it (#590, #2362).
          finalFocus={menuReturnsFocus}
          trigger={
            <header
              onPointerDown={onGrab}
              // A held touch stays the header's drag, not Base UI's long-press menu.
              onTouchStart={skipMenuHandler}
              onContextMenu={skipTouchMenu}
              data-pane-grab={onGrab === undefined ? undefined : ""}
              className={cn(
                "flex h-7 shrink-0 items-center gap-1 border-b border-border pr-0.5 pl-2.5 text-xs transition-colors duration-(--duration-micro)",
                focused ? "bg-raised text-foreground" : "text-muted-foreground",
                onGrab !== undefined && "cursor-grab select-none",
              )}
            >
              <h2 title={title} className="min-w-0 truncate">
                {title}
              </h2>
              {/* Each pane says its own machine reconnects, in its header, never over its output (#2464 review). */}
              {away === null ? null : (
                <span role="status" className="shrink-0 text-muted-foreground">
                  Reconnecting…
                </span>
              )}
              <PaneButtons zoomed={zoomed} onSplit={onSplit} onZoom={onZoom} onClose={onClose} />
            </header>
          }
        >
          <SessionMenuItems address={terminal.address} />
        </ContextMenu>
      ) : null}
      {/* The terminal's own box: the approval banner pins to its top, under a split pane's header, never over it. */}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <RegionBoundary
          region={`pane:${terminal.address}`}
          title="This terminal could not be drawn"
          detail="The program keeps running on the host."
        >
          {terminal.offline === true ? null : <ApprovalOverlay connection={connection} terminal={terminal} />}
          {terminal.offline === true && machine !== undefined ? (
            <MachineOffline machine={machine} />
          ) : (
            // A restarted program (a kept terminal's loss) has a new pid: its view attaches to it afresh.
            <TerminalView
              key={terminal.pid ?? undefined}
              connection={connection}
              address={terminal.address}
              pid={terminal.pid ?? null}
              live={terminal.state === "live"}
              focused={focused}
              claimed={claimed}
              label={`${title} output`}
              onEnd={onEnd}
              onEnded={() => onEnded(terminal.address, terminal.pid ?? null)}
              onPort={onPort}
            />
          )}
        </RegionBoundary>
      </div>
      {dock}
    </section>
  );
}
