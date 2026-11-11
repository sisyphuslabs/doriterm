import type { HcConnection } from "@doriface/client";
import type { Axis } from "@doriface/protocol/layout";
import { memo, useCallback, type ReactNode } from "react";
import type { TerminalEnd } from "../terminal/terminal-end.ts";
import type { Session } from "./model.ts";
import { Pane } from "./pane.tsx";
import type { PaneSends } from "./pane-sends.ts";

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
  /** This screen asked for this pane: its terminal takes the keyboard as it starts (#332). */
  readonly claimed: boolean;
  readonly zoomed: boolean;
  readonly actions: PaneActions;
  readonly sends: PaneSends;
  readonly dock: ReactNode;
  readonly onGrab: Parameters<typeof Pane>[0]["onGrab"];
}

/**
 * One pane of a tab. Every tab stays mounted, hidden ones included, so a terminal event that rendered every pane cost
 * each event as many renders as the core has terminals in tabs (#2086). Its props are plain values, the pane's own
 * terminal and callbacks that never change, so a pane renders again only when something it shows changed.
 */
export const PaneSlot = memo(function PaneSlot(props: PaneSlotProps) {
  const { connection, tab, pane, mod, terminal, split, focused, claimed, zoomed, actions, sends, dock, onGrab } = props;
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
});
