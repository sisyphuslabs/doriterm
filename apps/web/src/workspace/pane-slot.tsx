import type { HcConnection } from "@doriface/client";
import type { Axis } from "@doriface/protocol/layout";
import { memo, useCallback, useRef, type ReactNode } from "react";
import type { TerminalEnd } from "../terminal/terminal-end.ts";
import type { Session } from "./model.ts";
import { Pane } from "./pane.tsx";
import type { PaneSends } from "./pane-sends.ts";
import { usePaneMotion } from "./pane-motion.ts";
import type { Bump } from "./use-pane-moves.ts";

/** What a pane asks of its tab, by tab key and pane id: one object for every pane, the same on every render. */
export interface PaneActions {
  readonly focus: (tab: string, pane: string) => void;
  readonly split: (axis: Axis, tab: string, pane: string) => void;
  readonly zoom: (tab: string, pane: string) => void;
  readonly close: (address: string) => void;
  readonly end: (address: string, end: TerminalEnd) => void;
  readonly ended: (address: string, pid: number | null) => void;
}

export interface PaneSlotProps {
  readonly connection: HcConnection;
  readonly tab: string;
  readonly pane: string;
  /** herdr-app's panel this pane shows instead of a terminal, or null. */
  readonly mod: string | null;
  readonly terminal: Session | undefined;
  readonly split: boolean;
  readonly focused: boolean;
  /** On screen: its tab is the selected one and no zoom hides it. */
  readonly shown: boolean;
  /** This screen asked for this pane: its terminal takes the keyboard as it starts (#332). */
  readonly claimed: boolean;
  readonly zoomed: boolean;
  readonly actions: PaneActions;
  readonly sends: PaneSends;
  readonly dock: ReactNode;
  readonly onGrab: Parameters<typeof Pane>[0]["onGrab"];
}

function PaneSlot(props: PaneSlotProps) {
  const { connection, tab, pane, mod, terminal, split, focused, shown, claimed, zoomed, actions, sends, dock, onGrab } =
    props;
  const onFocus = useCallback(() => actions.focus(tab, pane), [actions, tab, pane]);
  const onSplit = useCallback((axis: Axis) => actions.split(axis, tab, pane), [actions, tab, pane]);
  const onZoom = useCallback(() => actions.zoom(tab, pane), [actions, tab, pane]);
  const address = terminal?.address;
  const onClose = useCallback(() => (address === undefined ? undefined : actions.close(address)), [actions, address]);
  if (terminal !== undefined) {
    return (
      <Pane
        connection={connection}
        terminal={terminal}
        focused={focused}
        shown={shown}
        claimed={claimed}
        split={split}
        onFocus={onFocus}
        onEnd={actions.end}
        zoomed={zoomed}
        onSplit={onSplit}
        onZoom={onZoom}
        onClose={onClose}
        onEnded={actions.ended}
        onPort={sends.onPort(terminal.address)}
        dock={dock}
        onGrab={onGrab}
      />
    );
  }
  const text = mod !== null ? `herdr-app's ${mod} panel opens in herdr-app.` : "Waiting for this terminal to start…";
  return (
    <section
      aria-label={mod === null ? "Starting terminal" : `${mod} panel`}
      data-focused={focused}
      tabIndex={-1}
      onFocus={onFocus}
      className="flex min-h-0 min-w-0 flex-1 items-center justify-center rounded-lg border border-border bg-card p-4 text-center text-sm text-muted-foreground"
    >
      {text}
    </section>
  );
}

export interface PlacedPaneProps extends PaneSlotProps {
  /** Its rectangle in the tab's box; all zero while a zoom hides it. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** The box all panes are laid out in: when it changes (a window resize) panes take their place without motion. */
  readonly frame: string;
  readonly grow: "row" | "column" | null;
  readonly bump: Bump | null;
  readonly hidden: boolean;
}

/**
 * One pane of a tab, placed by its rectangle. Every tab stays mounted, hidden ones included, so a terminal event that
 * rendered every pane cost each event as many renders as the core has terminals in tabs (#2086). Its props are plain
 * values, the pane's own terminal and callbacks that never change, so a pane renders again only when something it shows
 * or where it sits changed.
 */
export const PlacedPane = memo(function PlacedPane(props: PlacedPaneProps) {
  const { x, y, width, height, frame, grow, bump, hidden, ...slot } = props;
  const ref = useRef<HTMLDivElement>(null);
  usePaneMotion(ref, { rect: { x, y, width, height }, frame, grow, bump });
  return (
    <div ref={ref} hidden={hidden} className="absolute flex" style={{ left: x, top: y, width, height }}>
      <PaneSlot {...slot} />
    </div>
  );
});
