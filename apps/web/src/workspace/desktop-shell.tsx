import type { HcConnection } from "@doriface/client";
import { type AgentStatus, cn, IconButton, TabBar, useToastManager, type WorkspaceTab } from "@doriface/ui";
import { Bot, Columns2, PanelLeft, Rows2, SquareTerminal, Terminal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { actionChosen } from "../keys/dispatcher.ts";
import { useActionKeys } from "../keys/use-action-keys.ts";
import { DictateButton } from "../voice/dictate-button.tsx";
import { useDictation } from "../voice/use-dictation.ts";
import { VoiceDock } from "../voice/voice-dock.tsx";
import { agentStatus } from "./attention.ts";
import { machineOf, programKind, type Session, tabTitle, terminalTitle } from "./model.ts";
import { NewTabMenu } from "./new-tab-menu.tsx";
import { FirstRunGuideCard } from "../pair/first-run-guide-card.tsx";
import { guideStore } from "../pair/first-run-guide.ts";
import { NoTerminal } from "./no-terminal.tsx";
import { QuietBusy } from "../terminal/quiet-busy.tsx";
import { usePaneSends } from "./pane-sends.ts";
import { panelId, SplitPanes } from "./split-panes.tsx";
import { useTabRename } from "./tab-rename.tsx";
import { DesktopStatusBar } from "./desktop-status-bar.tsx";
import { SessionMenu } from "./session-menu.tsx";
import { Sidebar } from "./sidebar.tsx";
import { sidebarFilter } from "./sidebar-filter-field.tsx";
import { SkipLinks } from "./skip-links.tsx";
import { useAppActions, type SessionVerb } from "./use-app-actions.ts";
import { useArrivalReady, workspaceSettled } from "./use-arrival-ready.ts";
import { behindModal, useFocusSidebar } from "./use-focus-sidebar.ts";
import { useSidebarShown, useSidebarSize } from "./layout-store.ts";
import { findTerminal, type LayoutTab } from "./layout-model.ts";
import type { MachineIds } from "./tab-keys.ts";
import { readDisplay } from "../terminal/display.ts";
import { attachAhead, openingCallsOf } from "../terminal/opening-attach.ts";
import type { Axis } from "@doriface/protocol/layout";
import type { Layout, PaneTarget } from "./use-layout.ts";
import type { TerminalEnd } from "../terminal/terminal-end.ts";

/** A tab's glyph: the state that most needs the person among its panes, as the sidebar sections rank them. */
const URGENCY: readonly AgentStatus[] = ["blocked", "done", "working", "idle", "unknown"];

/** herdr-app's program icons for what a tab runs: an agent, a shell, or another program (its `defaults/icons`). */
const PROGRAM_ICON = {
  agent: <Bot aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />,
  shell: <Terminal aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />,
  program: <SquareTerminal aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />,
};

/**
 * A tab as the strip draws it: its name, else its agent's title (#1541), else its place in its space (1, 2, ...), with the icon of its agent,
 * else of its first pane's program, and the state that most needs the person among its panes. No machine label: the bar
 * shows one space's tabs, and a space is one machine's (#404, #478).
 */
function tabEntry(tab: LayoutTab, position: number, byAddress: ReadonlyMap<string, Session>): WorkspaceTab {
  const shown = tab.panes.flatMap((pane) => {
    const terminal = pane.address === null ? undefined : byAddress.get(pane.address);
    return terminal === undefined ? [] : [terminal];
  });
  const kinds = shown.map(programKind);
  const kind = kinds.includes("agent") ? "agent" : kinds[0];
  const agent = shown[kinds.indexOf("agent")];
  const statuses = new Set(shown.map(agentStatus));
  const status = URGENCY.find((each) => statuses.has(each));
  return {
    id: tab.key,
    title: tabTitle(tab.name, position, agent),
    controls: panelId(tab.key),
    pinned: tab.pinned,
    ...(kind === undefined ? {} : { icon: PROGRAM_ICON[kind] }),
    ...(status === undefined ? {} : { status }),
  };
}

/** The tab whose button has keyboard focus, which Move tab left/right moves instead of the active one. */
const focusedTab = (): string | null =>
  document.activeElement?.closest("[data-tab-id]")?.getAttribute("data-tab-id") ?? null;

const FOCUSED_TERMINAL_INPUT = '[data-focused="true"] [data-terminal] textarea';

export interface DesktopShellProps {
  readonly connection: HcConnection;
  readonly terminals: readonly Session[];
  /** The machines as now named, so the first-run guide finds its terminal after a rename (#1198). */
  readonly ids: MachineIds;
  /** False until the core has listed its terminals; the count would read 0 until then. */
  readonly loaded: boolean;
  readonly layout: Layout;
  /** Every space in the order the sidebar lists them (`spaceKey`s), for the space keys. */
  readonly spaceKeys: readonly string[];
  readonly onSelectSpace: (key: string) => void;
  readonly onNew: () => void;
  /** New tab cannot start a terminal now (its machine is unreachable or its layout takes no edits). */
  readonly newDisabled: boolean;
  /** Starts an hc template (an agent) as a new tab, from the New tab menu. */
  readonly onNewAgent: (template: string) => void;
  readonly onNewSpace: () => void;
  readonly onSplit: (axis: Axis, target?: PaneTarget) => void;
  readonly onCloseTab: (key: string) => void;
  /** Closes several tabs at once ("Close tabs to the right", "Close other tabs"), asking once (#1561). */
  readonly onCloseTabs: (keys: readonly string[]) => void;
  readonly onClosePane: (address: string) => void;
  readonly onEnd: (address: string, end: TerminalEnd) => void;
  readonly onPalette: () => void;
  readonly onSession: SessionVerb;
}

const viewKey = (address: string, pid: number | null): string => `${address}#${pid ?? ""}`;

export function DesktopShell(props: DesktopShellProps) {
  const {
    connection,
    terminals,
    ids,
    loaded,
    layout,
    spaceKeys,
    onSelectSpace,
    onNew,
    onNewAgent,
    onNewSpace,
    onSplit,
    onCloseTab,
    onCloseTabs,
    onClosePane,
    onEnd,
    onPalette,
    onSession,
  } = props;
  const toasts = useToastManager();
  const [sidebar, setSidebar] = useSidebarShown();
  const [{ rail }, setSidebarSize] = useSidebarSize();
  const sidebarKeys = useActionKeys("layout.toggle:sidebar");
  const newTabKeys = useActionKeys("tab.new");
  const moveLeftKeys = useActionKeys("tab.move:left");
  const moveRightKeys = useActionKeys("tab.move:right");
  const focusSidebar = useFocusSidebar(sidebar, () => setSidebar(true));
  // The filter key shows the whole sidebar (out of hiding, off the rail) with its field focused. Behind a modal dialog
  // (the palette, a rename) it does nothing, as the focus key does, so focus stays in the dialog; chosen from the palette
  // it runs, since the palette closes as it does (#848).
  const filterSidebar = (): void => {
    if (behindModal() && !actionChosen()) return;
    setSidebar(true);
    if (rail) setSidebarSize({ rail: false });
    sidebarFilter.ask();
  };
  const focusedAddress = layout.focused?.address ?? null;
  const voice = useDictation();
  const sends = usePaneSends();
  const mic = useRef<HTMLButtonElement>(null);
  // A dictation belongs to the pane it started in: moving focus to another tab or pane ends it, typing nothing.
  const { dictation } = voice;
  useEffect(() => dictation.close(), [dictation, layout.active?.key, layout.focused?.id]);
  // Views that showed their program had already ended (a restarted program has a new pid, so its view counts afresh).
  const [endedViews, setEndedViews] = useState<ReadonlySet<string>>(() => new Set());
  const onEnded = useCallback((address: string, pid: number | null) => {
    const key = viewKey(address, pid);
    setEndedViews((seen) => (seen.has(key) ? seen : new Set(seen).add(key)));
  }, []);
  const showsEnded = (terminal: { readonly address: string; readonly pid?: number | null }): boolean =>
    endedViews.has(viewKey(terminal.address, terminal.pid ?? null));
  const byAddress = new Map(terminals.map((terminal) => [terminal.address, terminal]));
  const tabList: WorkspaceTab[] = layout.shown.map((tab, position) => tabEntry(tab, position, byAddress));
  const tabRename = useTabRename(layout, tabList);
  useAppActions({
    terminals,
    layout,
    spaceKeys,
    onSelectSpace,
    onNew,
    onNewSpace,
    onSplit,
    onCloseTab,
    onClosePane,
    onRenameTab: tabRename.open,
    onToggleSidebar: () => setSidebar((shown) => !shown),
    onFocusSidebar: focusSidebar,
    onFilterSidebar: filterSidebar,
    onSession,
    // The session in view, as the tab bar's mic acts on it; none in view (or its machine offline) leaves the key alone.
    onDictate: () => {
      const target = terminals.find((terminal) => terminal.address === focusedAddress);
      if (target === undefined || target.offline === true || showsEnded(target)) return false;
      voice.toggle();
      return true;
    },
    focusedTab,
  });
  // With nothing focused the bar names no machine: the core this page goes through is not the person's (#2531).
  const focusedMachine =
    focusedAddress === null ? undefined : (machineOf(focusedAddress) ?? connection.hello.core.name);
  const focusedTerminal = focusedAddress === null ? undefined : byAddress.get(focusedAddress);
  // As on the phone: a focused terminal that is gone, whose machine is offline, or whose view showed it had ended has
  // nothing to type into, so a dictation under way ends (its recognizer aborted) and no mic or bound key starts one (#254, #258).
  const nothingToType =
    focusedTerminal === undefined || focusedTerminal.offline === true || showsEnded(focusedTerminal);
  useEffect(() => {
    if (nothingToType) dictation.close();
  }, [dictation, nothingToType]);
  const live = terminals.filter((terminal) => terminal.state === "live" && terminal.offline !== true);
  // As on the phone: no tabs means nothing is open only once the saved layout has answered, or once the core has listed
  // no live terminal (then there is nothing for the layout to bring back).
  const nothingOpen = layout.restored || (loaded && live.length === 0);
  const openTerminal = (address: string): void => {
    guideStore.opened(address, ids);
    if (findTerminal(layout.tabs, address) === null) {
      attachAhead(connection, openingCallsOf(connection), address, readDisplay(document.documentElement));
    }
    layout.placeTerminal(address);
  };
  useArrivalReady(
    workspaceSettled(loaded, { open: layout.tabs.map((tab) => tab.key), restored: layout.restored }, live.length),
  );
  const splitRightKeys = useActionKeys("pane.split:right");
  const splitDownKeys = useActionKeys("pane.split:down");
  const cannotSplit = focusedTerminal === undefined || layout.active?.readOnly != null;
  const split = (
    <>
      <IconButton
        label="Split right"
        {...(splitRightKeys === undefined ? {} : { keys: splitRightKeys })}
        icon={<Columns2 />}
        disabled={cannotSplit}
        onClick={() => onSplit("row")}
      />
      <IconButton
        label="Split down"
        {...(splitDownKeys === undefined ? {} : { keys: splitDownKeys })}
        icon={<Rows2 />}
        disabled={cannotSplit}
        onClick={() => onSplit("column")}
      />
    </>
  );

  return (
    // --titlebar-leading: where a titlebar row's own content starts, past the window buttons, the sidebar toggle and
    // herdr-app's 12 px gap.
    <div className="relative flex h-dvh overflow-hidden bg-background pt-(--safe-top) pr-(--safe-right) pb-(--safe-bottom) pl-(--safe-left) [--titlebar-leading:calc(var(--titlebar-inset-start,0.5rem)+var(--control-sm)+0.75rem)]">
      <SkipLinks onSidebar={focusSidebar} />
      <FirstRunGuideCard
        className="absolute right-4 bottom-10 z-30 m-0 w-72 shadow-lg"
        listVisible={sidebar}
        live={terminals.filter((terminal) => terminal.state === "live").map((terminal) => terminal.address)}
        ids={ids}
        onNew={onNew}
      />
      {sidebar ? (
        <Sidebar terminals={terminals} active={focusedAddress} onOpen={openTerminal} onPalette={onPalette} />
      ) : null}
      {/* The titlebar's leading strip, beside the toggle and, with the sidebar hidden, before it: it keeps the chrome and
          the window drag where the tab strip's own box used to reach (#643). It comes before the toggle so the toggle's
          no-drag box is listed after it, and the strip below starts past both of them. Its width is the strip's margin,
          so the two tile: the strip's own padding-left is what the row's px-2.5 gives it, and its content therefore
          starts where it did before (--titlebar-leading, or 0.625rem past the rail). */}
      {sidebar && !rail ? null : (
        <div
          data-titlebar
          className={cn(
            "absolute top-(--safe-top) h-(--tabbar-height) border-b border-border bg-chrome",
            rail
              ? "left-[calc(var(--safe-left)+var(--sidebar-rail-width))] w-[max(0rem,calc(var(--titlebar-leading)-var(--sidebar-rail-width)-0.625rem))] pl-[max(0rem,calc(var(--titlebar-inset-start,0.5rem)-var(--sidebar-rail-width)))]"
              : "left-(--safe-left) w-[max(0rem,calc(var(--titlebar-leading)-0.625rem))] pl-[var(--titlebar-inset-start,0.5rem)]",
          )}
        />
      )}
      {/* One sidebar toggle in the same place whether the sidebar is open or not, right after the window buttons (#415). It
          comes after the sidebar in the DOM so the skip links stay the first Tab stops and it is the stop just before the tabs. */}
      <div
        data-titlebar
        className="absolute top-(--safe-top) left-[calc(var(--safe-left)+var(--titlebar-inset-start,0.5rem))] z-10 flex h-11 items-center"
      >
        <IconButton
          label={sidebar ? "Hide sidebar" : "Show sidebar"}
          aria-expanded={sidebar}
          {...(sidebarKeys === undefined ? {} : { keys: sidebarKeys })}
          icon={<PanelLeft />}
          onClick={() => setSidebar((shown) => !shown)}
        />
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TabBar
          tabs={tabList}
          activeId={layout.active?.key ?? ""}
          {...(newTabKeys === undefined ? {} : { newTabKeys })}
          onSelect={layout.selectTab}
          onClose={onCloseTab}
          onPin={(key, pinned) =>
            void layout.pinTab(key, pinned).catch((cause: unknown) =>
              toasts.add({
                type: "error",
                title: pinned ? "The tab was not pinned" : "The tab was not unpinned",
                description: cause instanceof Error ? cause.message : String(cause),
              }),
            )
          }
          onCloseSet={(key, which) => onCloseTabs(layout.closeSetOf(key, which))}
          onNew={onNew}
          newDisabled={props.newDisabled}
          newMenu={
            <NewTabMenu
              connection={connection}
              newTabKeys={newTabKeys}
              onNew={onNew}
              onAgent={onNewAgent}
              onSpace={onNewSpace}
            />
          }
          onRename={tabRename.open}
          onMove={layout.moveTab}
          moveKeys={{
            ...(moveLeftKeys === undefined ? {} : { left: moveLeftKeys }),
            ...(moveRightKeys === undefined ? {} : { right: moveRightKeys }),
          }}
          moved={layout.lastMove === null ? null : { id: layout.lastMove.key, count: layout.lastMove.count }}
          {...(sidebar && !rail
            ? {}
            : {
                // The strip starts past the toggle rather than under it: Electron lists the strip's drag box after the
                // toggle's no-drag one and the later box wins, so a click on the toggle would drag the window (#643).
                className: sidebar
                  ? "ml-[max(0rem,calc(var(--titlebar-leading)-var(--sidebar-rail-width)-0.625rem))]"
                  : "ml-[max(0rem,calc(var(--titlebar-leading)-0.625rem))]",
              })}
          trailing={
            <>
              {focusedTerminal === undefined || nothingToType ? null : (
                <DictateButton voice={voice} target={terminalTitle(focusedTerminal)} size="sm" ref={mic} />
              )}
              {focusedTerminal === undefined ? null : (
                <SessionMenu address={focusedTerminal.address} title={terminalTitle(focusedTerminal)} />
              )}
              {split}
            </>
          }
        />
        {tabRename.dialog}
        {/* The page's one main landmark: the panes, between the tab strip and the status bar (#1378). */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {layout.tabs.length > 0 ? null : nothingOpen ? (
            <NoTerminal onNew={onNew} />
          ) : (
            <QuietBusy label="Restoring your tabs" text="Restoring your tabs…" className="flex-1" />
          )}
          <SplitPanes
            connection={connection}
            terminals={terminals}
            layout={layout}
            titles={new Map(tabList.map((tab) => [tab.id, tab.title]))}
            onEnd={onEnd}
            onSplit={onSplit}
            onClose={onClosePane}
            onEnded={onEnded}
            sends={sends}
            dock={
              focusedTerminal === undefined || nothingToType ? null : (
                <VoiceDock
                  voice={voice}
                  target={terminalTitle(focusedTerminal)}
                  onType={(text) => {
                    sends.type(focusedTerminal.address, text);
                    document.querySelector<HTMLElement>(FOCUSED_TERMINAL_INPUT)?.focus();
                  }}
                  onClose={() => mic.current?.focus()}
                  className="pb-2"
                />
              )
            }
          />
        </main>
        <DesktopStatusBar
          terminals={terminals}
          live={live}
          loaded={loaded}
          focusedAddress={focusedAddress}
          focusedTerminal={focusedTerminal}
          focusedMachine={focusedMachine}
          onOpen={openTerminal}
          onPalette={onPalette}
        />
      </div>
    </div>
  );
}
