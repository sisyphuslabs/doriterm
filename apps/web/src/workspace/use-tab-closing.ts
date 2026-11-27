import type { Terminal } from "@doriface/protocol";
import { type Dispatch, type RefObject, type SetStateAction, useEffect, useRef, useState } from "react";
import { findTerminal, type LayoutTab, TRANSIENT } from "./layout-model.ts";
import type { SessionAsk } from "./session-context.ts";
import type { Layout } from "./use-layout.ts";
import { useStableCallback } from "./use-stable-callback.ts";

/** What a close asked of the terminal shown alone does once the tabs change. */
export type HeldClose = "wait" | "close" | "drop";

/**
 * A close of the terminal shown alone (the TRANSIENT tab) while this page's start of it has not settled (`opening`: its
 * run has not answered, so no space holds its tab yet) waits for that answer to place it, then goes ahead as the placed
 * tab's close: a space's last tab asks Close space? as it always does, instead of the shell ending unasked (#2911,
 * #2913). It is bounded by the run: once the run has answered or failed it goes ahead on whatever tab shows the terminal,
 * and it is dropped once the terminal is no longer live.
 */
export function heldClose(
  tabs: readonly LayoutTab[],
  terminals: readonly Pick<Terminal, "address" | "state">[],
  address: string,
  opening: boolean,
): HeldClose {
  if (!terminals.some((terminal) => terminal.address === address && terminal.state === "live")) return "drop";
  const found = findTerminal(tabs, address);
  const placed = found !== null && found.tab.key !== TRANSIENT;
  return placed || !opening ? "close" : "wait";
}

/** What a close of this tab does once it is confirmed: the phone leaving the tab it is showing (#1478). */
export type AfterClose = RefObject<{ readonly key: string; readonly leave: () => void } | null>;

export interface TabClosing {
  /** The tab whose close asks first (CloseTabDialog), and the tabs a close-to-the-right or close-others asks about. */
  readonly closingTab: string | null;
  readonly setClosingTab: Dispatch<SetStateAction<string | null>>;
  readonly closingSet: readonly string[];
  readonly setClosingSet: Dispatch<SetStateAction<readonly string[]>>;
  readonly afterClose: AfterClose;
  readonly lastOfSpace: (tab: LayoutTab | undefined) => boolean;
  /** The close of tab `key` went ahead: what it does afterwards (afterClose) runs now. */
  readonly closed: (key: string) => void;
  readonly closeTab: (key: string) => void;
  readonly closeTabs: (keys: readonly string[]) => void;
  readonly closePane: (address: string) => void;
  /** The terminal whose close waits for its tab to be placed: its tab shows the close as taken. */
  readonly holding: string | null;
}

/** Closing panes and tabs as herdr-app does: what asks first, what goes at once, and what waits for its tab. */
export function useTabClosing(
  layout: Pick<Layout, "tabs" | "closeTab">,
  terminals: readonly Pick<Terminal, "address" | "state">[],
  setAsk: Dispatch<SetStateAction<SessionAsk | null>>,
  /** Whether this page's start of the terminal has not settled yet (useMachineRuns). */
  opening: (address: string) => boolean,
): TabClosing {
  const [closingTab, setClosingTab] = useState<string | null>(null);
  const [closingSet, setClosingSet] = useState<readonly string[]>([]);
  const [held, setHeld] = useState<string | null>(null);
  // A space's last tab takes the space with it, as herdr-app's tab.close: that always asks first (CloseTabDialog).
  const lastOfSpace = (tab: LayoutTab | undefined): boolean =>
    tab !== undefined && !tab.transient && layout.tabs.filter((each) => each.spaceKey === tab.spaceKey).length === 1;
  const afterClose = useRef<{ readonly key: string; readonly leave: () => void } | null>(null);
  const closed = (key: string): void => {
    const after = afterClose.current;
    if (after?.key !== key) return;
    afterClose.current = null;
    after.leave();
  };
  const closeTab = (key: string): void => {
    const tab = layout.tabs.find((each) => each.key === key);
    const alone = tab?.key === TRANSIENT ? tab.panes[0]?.address : undefined;
    if (alone != null && opening(alone)) return setHeld(alone);
    if (lastOfSpace(tab)) return setClosingTab(key);
    const shown = tab?.panes.flatMap((pane) => (pane.address === null ? [] : [pane.address])) ?? [];
    const [only] = shown;
    if (shown.length === 1 && only !== undefined) setAsk({ kind: "close", address: only });
    else if (shown.length > 1) setClosingTab(key);
    else {
      closed(key);
      layout.closeTab(key);
    }
  };
  // "Close tabs to the right" and "Close other tabs" (#1561): at once when nothing runs in them, else one question for
  // all of them, as closing one tab of several panes asks once.
  const closeTabs = (keys: readonly string[]): void => {
    const closing = layout.tabs.filter((tab) => keys.includes(tab.key));
    const running = closing.some((tab) => tab.panes.some((pane) => pane.address !== null));
    if (running) setClosingSet(closing.map((tab) => tab.key));
    else for (const tab of closing) layout.closeTab(tab.key);
  };
  // A tab's only pane closes as its tab, as herdr-app's pane.close does.
  const closePane = (address: string): void => {
    const found = findTerminal(layout.tabs, address);
    if (found !== null && found.tab.panes.length === 1) closeTab(found.tab.key);
    else setAsk({ kind: "close", address });
  };
  const step = held === null ? null : heldClose(layout.tabs, terminals, held, opening(held));
  const placed = useStableCallback((address: string): void => {
    setHeld(null);
    // What the close does afterwards was asked of the tab shown alone; it is now the placed tab's.
    const found = findTerminal(layout.tabs, address);
    const after = afterClose.current;
    if (found !== null && after?.key === TRANSIENT) afterClose.current = { ...after, key: found.tab.key };
    closePane(address);
  });
  useEffect(() => {
    if (held === null || step === "wait") return;
    if (step === "close") placed(held);
    else setHeld(null);
  }, [held, step, placed]);
  return {
    closingTab,
    setClosingTab,
    closingSet,
    setClosingSet,
    afterClose,
    lastOfSpace,
    closed,
    closeTab,
    closeTabs,
    closePane,
    holding: held,
  };
}
