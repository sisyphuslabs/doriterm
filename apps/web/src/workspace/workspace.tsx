import type { TerminalRunParams } from "@doriface/protocol";
import type { HcConnection } from "@doriface/client";
import { useToastManager } from "@doriface/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { connectionStore } from "../connection/store.ts";
import { useActionHandler } from "../keys/dispatcher.ts";
import { ShortcutsHelp } from "../keys/shortcuts-dialog.tsx";
import type { Axis } from "@doriface/protocol/layout";
import { closesTab, type TerminalEnd } from "../terminal/terminal-end.ts";
import { CloseTabDialog } from "./close-tab-dialog.tsx";
import { stillClosing } from "./close-set.ts";
import { AddMachineDialog } from "./add-machine-dialog.tsx";
import { guideStore } from "../pair/first-run-guide.ts";
import { usePhoneRoute } from "./use-phone-route.ts";
import { DesktopShell } from "./desktop-shell.tsx";
import { Palette } from "./palette.tsx";
import { SessionContext, type SessionAsk } from "./session-context.ts";
import { SessionDialogs } from "./session-dialogs.tsx";
import { SpaceClose } from "./space-close-dialog.tsx";
import { SpaceRename } from "./space-rename-dialog.tsx";
import { availableActions } from "./shell-actions.ts";
import { someoneElseNeedsYou } from "./attention.ts";
import { PhoneShell } from "./phone-shell.tsx";
import { phoneSpaces } from "./phone-space-rows.ts";
import type { SessionVerb } from "./use-app-actions.ts";
import { useMachineRuns } from "./use-machine-runs.ts";
import { PIN_LABEL, spacesInOrder } from "./sidebar-model.ts";
import { PinContext, type PinTerminal } from "./use-pin.ts";
import { machineGone } from "./machine-grace.ts";
import { MachinesContext, useMachines } from "./use-machines.ts";
import { runParamsFor } from "./new-terminal.ts";
import { useNarrow } from "./use-narrow.ts";
import { machineIds } from "./tab-keys.ts";
import { findTerminal, type LayoutTab } from "./layout-model.ts";
import { useLayout, withoutClaim, type PaneTarget } from "./use-layout.ts";
import { chainedSplit, SplitChain } from "./split-chain.ts";
import { afterEnd } from "./session-actions.ts";
import { useDeadPanes } from "./use-dead-panes.ts";
import { useDropOnce } from "./use-drop-once.ts";
import { useLayoutDocs } from "./use-layout-docs.ts";
import { GitFactsContext, useGitFacts } from "./git-facts.ts";
import { TodoProgressContext, useTodoProgress } from "./todo-progress.ts";
import { layoutSpaces, liveTabs, phoneTabTitle, spaceOfAddress } from "./model.ts";
import { nextAfterClosing } from "./phone-space-rows.ts";
import { SpaceSelectionContext } from "./space-selection.ts";
import { useSpaceMove } from "./space-order.ts";
import { useAdoptLoose } from "./use-adopt-loose.ts";
import { useAttention } from "./use-attention.ts";
import { orderNotSaved } from "./machine-order.ts";
import { useMachineOrder } from "./use-machine-order.ts";
import { useTerminals } from "./use-terminals.ts";
import { useForgetEndedHistoryGaps } from "../terminal/history-gap-notice.ts";
import { useResumeEnds } from "./resume-ends.ts";
import { useRedrawNotice } from "./use-redraw-notice.ts";
import { useSteady } from "./steady.ts";
import { useStableCallback } from "./use-stable-callback.ts";
import { useNoticeOpen } from "../push/notice-open.ts";
import { usePushPresence } from "../push/use-push-presence.ts";
import { PromptAnswerBanner } from "../push/prompt-answer-banner.tsx";
import { CATCHER_ATTRIBUTES, type DropReason, useTypeAhead } from "./use-type-ahead.ts";

export interface WorkspaceProps {
  readonly connection: HcConnection;
}

/** The live terminals of one core: the desktop shell from `md` up, the phone navigation below. */
export function Workspace({ connection }: WorkspaceProps) {
  const fed = useTerminals(connection);
  useRedrawNotice(connection);
  useForgetEndedHistoryGaps(fed.loaded, fed.terminals);
  const {
    entries: listed,
    terminals,
    refresh,
    listError,
    views,
    heard: heardMachines,
    retry,
    remove,
    listed: machineReads,
  } = useMachines(connection, fed.terminals);
  // Opened and re-read on what hc said: a document read while its line was down is read again once the line is back.
  const { layouts } = useLayoutDocs(connection, heardMachines, views);
  const gitOf = useGitFacts(connection, views);
  const todoOf = useTodoProgress(connection, fed.terminals);
  const order = useMachineOrder(connection, listed);
  const entries = order.entries;
  const toasts = useToastManager();
  const { move: saveMove } = order;
  const moveMachine = useCallback(
    function move(core: string, to: number): Promise<boolean> {
      return saveMove(core, to).catch((cause: unknown) => {
        const id = toasts.add({
          type: "error",
          ...orderNotSaved(cause),
          actionProps: {
            children: "Retry",
            onClick: () => {
              toasts.close(id);
              void move(core, to);
            },
          },
        });
        return false;
      });
    },
    [saveMove, toasts],
  );
  // A write the link dropped under is lost with the link, which the connection notice already names: the toast says what
  // to do, as a failed New terminal does, never the closed link's raw cause (#698).
  const failed = useCallback(
    (message: string) =>
      toasts.add({
        type: "error",
        title: "The layout was not saved",
        description: connection.closed
          ? `Reconnecting to ${connection.hello.core.name}; make the change again once it is back.`
          : message,
      }),
    [connection, toasts],
  );
  const told = useCallback((message: string) => toasts.add({ type: "info", title: message }), [toasts]);
  const unsaved = useCallback(
    (message: string) =>
      toasts.add({
        type: "error",
        title: "The tab selection was not saved",
        description: `${message.replace(/\.$/, "")}. This window keeps it until it reloads.`,
      }),
    [toasts],
  );
  const layout = useLayout(
    connection.hello.core.id,
    layouts,
    fed.loaded ? terminals : [],
    failed,
    told,
    unsaved,
    machineReads > 0,
  );
  // A session that ends is dropped from the layout once; a refused drop keeps the pane, showing the ended session.
  const { dropEnded, closing: closingSessions, kept, dropped } = useDropOnce(terminals, layout.dropPane);
  useAdoptLoose(connection, layouts, fed.loaded ? terminals : null, failed);
  const narrow = useNarrow();
  const ids = useMemo(() => machineIds(views), [views]);
  // New tab starts its terminal on the machine of the tab in view: offered disabled while that machine is past its
  // reconnect grace, or its layout takes no edits, never offered and then refused (#2455).
  const activeMachine = layout.active?.machine ?? null;
  const activeView =
    activeMachine === null ? undefined : views.find((v) => v.name === activeMachine || v.id === activeMachine);
  const newDisabled = (layout.active?.readOnly ?? null) !== null || machineGone(activeView?.state);
  const phone = usePhoneRoute(narrow, ids);
  const { open: phoneOpen, show: showOnPhone } = phone;
  const phoneTab = phoneOpen === null ? null : findTerminal(layout.tabs, phoneOpen);
  const phonePanes = phoneTab?.tab.panes.flatMap((pane) => (pane.address === null ? [] : [pane.address])) ?? [];
  // The panes on screen: the open tab's on a phone, the selected tab's on a desktop. A terminal that ended in one of
  // them is its view's to say ("This session ended"); every other pane goes once its terminal is over (#2122).
  const onScreen = narrow
    ? phonePanes
    : (layout.active?.panes.flatMap((pane) => (pane.address === null ? [] : [pane.address])) ?? []);
  // As a view's end does: an End of the session drops its pane only once it has removed the terminal (see afterEnd).
  const dropDead = useCallback((address: string) => afterEnd(address, () => dropEnded(address)), [dropEnded]);
  // An ended pane this screen showed went from its tab with no drop of its own while its document stayed: another
  // device, which had it out of view, took it (#2146, #2231). The person looking at it is told why, here only.
  const endedElsewhere = useCallback(
    (address: string): void => {
      if (dropped(address)) return;
      toasts.add({
        type: "info",
        title: "This session ended",
        description: "Another device removed its pane once its program had finished.",
      });
    },
    [dropped, toasts],
  );
  // A pane is asked about only on what hc said: a machine held connected through a redial may have no terminals listed.
  useDeadPanes(
    connection,
    layout.tabs,
    fed.loaded ? terminals : null,
    heardMachines,
    machineReads,
    dropDead,
    onScreen,
    endedElsewhere,
    layouts,
  );
  const [palette, setPalette] = useState(false);
  const [ask, setAsk] = useState<SessionAsk | null>(null);
  const [spaceAsk, setSpaceAsk] = useState<string | null>(null);
  const [spaceClosing, setSpaceClosing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  useActionHandler("app", (action) => {
    if (action !== "app.palette") return false;
    setPalette((shown) => !shown);
    return true;
  });
  const { openTerminal: openInLayout } = layout;
  const opened = useCallback(
    (address: string): void => {
      openInLayout(address);
      showOnPhone(address);
    },
    [openInLayout, showOnPhone],
  );
  const [closingTab, setClosingTab] = useState<string | null>(null);
  const [closingSet, setClosingSet] = useState<readonly string[]>([]);
  const notSent = useCallback(
    (reason: DropReason) =>
      toasts.add({
        type: "error",
        title: "What you typed was not sent",
        description:
          reason === "failed"
            ? "The new terminal did not start, so the keys typed for it went nowhere."
            : "The new terminal took too long to open, so the keys typed for it were dropped.",
      }),
    [toasts],
  );
  const typeAhead = useTypeAhead(notSent);
  const runs = useMachineRuns(connection, opened, refresh, typeAhead, terminals);
  const [splits] = useState(() => new SplitChain());
  // A split key reads focus from the last render; the chain hands a landed split's pane on until this render shows it.
  const shownTab = layout.active?.key;
  const shownPane = layout.focused?.id;
  useEffect(() => {
    if (shownTab !== undefined && shownPane !== undefined) splits.shown(shownTab, shownPane);
  }, [splits, shownTab, shownPane]);
  const inView = narrow ? phoneOpen : (layout.focused?.address ?? null);
  // A new tab goes to the selected space (openTerminal), so it starts where that space is when no terminal is in focus.
  const newTerminal = (template?: string): void => {
    runs.start(
      {
        ...runParamsFor(
          terminals.find((terminal) => terminal.address === inView),
          spaces.find((space) => space.id === layout.active?.spaceKey),
        ),
        ...(template === undefined ? {} : { argv: [template], name: template }),
      },
      // The first run's agent step completes once the terminal really started, not when it was asked for (#668).
      (address) => {
        guideStore.opened(address, ids);
        opened(address);
      },
    );
  };
  // The latest `opened`, into a named space: a tab started from a space screen goes after that space's selected tab once
  // it is the selected one (addTab's `near`), and into that space even when it has no tab to select.
  const openInSpace = useRef<(address: string, key: string) => void>(() => undefined);
  openInSpace.current = (address, key) => {
    openInLayout(address, false, key);
    showOnPhone(address);
  };
  const newTabIn = (key: string): void => {
    const space = spaces.find((each) => each.id === key);
    const near = terminals.find((terminal) => terminal.state === "live" && space?.addresses.includes(terminal.address));
    // The terminal being started holds the keyboard (use-type-ahead): the space's tab in view must not claim it.
    withoutClaim(() => layout.selectSpace(key));
    runs.start(runParamsFor(near, space), (address) => {
      guideStore.opened(address, ids);
      openInSpace.current(address, key);
    });
  };
  const split = (axis: Axis, target?: PaneTarget): void => {
    const from =
      target === undefined
        ? inView
        : layout.tabs.find((tab) => tab.key === target.tab)?.panes.find((pane) => pane.id === target.pane)?.address;
    const near = terminals.find((terminal) => terminal.address === from);
    const tab = target === undefined ? layout.active : layout.tabs.find((each) => each.key === target.tab);
    const focused = layout.focused?.id;
    if (tab === undefined || tab === null || tab.transient || focused === undefined) {
      return runs.start(runParamsFor(near), (address) => layout.split(axis, address, target));
    }
    return chainedSplit(
      splits,
      { tab: tab.key, focused, source: target?.pane ?? null },
      (place, fail) => runs.start(runParamsFor(near), place, fail),
      (address, pane, made) => layout.split(axis, address, { tab: tab.key, pane }, made),
    );
  };
  // A space's last tab takes the space with it, as herdr-app's tab.close: that always asks first (CloseTabDialog).
  const lastOfSpace = (tab: LayoutTab | undefined): boolean =>
    tab !== undefined && !tab.transient && layout.tabs.filter((each) => each.spaceKey === tab.spaceKey).length === 1;
  // What a close of this tab does once it is confirmed, not while it asks and not when it is cancelled: the phone
  // leaving the tab it is showing (#1478).
  const afterClose = useRef<{ readonly key: string; readonly leave: () => void } | null>(null);
  const closed = (key: string): void => {
    const after = afterClose.current;
    if (after?.key !== key) return;
    afterClose.current = null;
    after.leave();
  };
  const closeTab = (key: string): void => {
    const tab = layout.tabs.find((each) => each.key === key);
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
  const onEnd = (address: string, end: TerminalEnd): void => {
    // An End of this session drops its pane only once it has removed the terminal (see afterEnd).
    if (closesTab(end)) afterEnd(address, () => dropEnded(address));
  };
  // A tab's only pane closes as its tab, as herdr-app's pane.close does.
  const closePane = (address: string): void => {
    const found = findTerminal(layout.tabs, address);
    if (found !== null && found.tab.panes.length === 1) closeTab(found.tab.key);
    else setAsk({ kind: "close", address });
  };
  const closing = layout.tabs.find((tab) => tab.key === closingTab);
  // The tabs a close-to-the-right or close-others takes, as one tab of all their panes for the one question it asks.
  const closingTabs = stillClosing(layout.tabs, closingSet);
  const [firstClosing] = closingTabs;
  const closingSetTab =
    firstClosing === undefined ? undefined : { ...firstClosing, panes: closingTabs.flatMap((tab) => tab.panes) };
  const phoneTitle = phoneTab === null ? null : phoneTabTitle(phoneTab.tab.name);
  usePushPresence(inView);
  useNoticeOpen(connectionStore.settings.mode === "relay" ? connectionStore.settings.hostId : undefined, opened);
  // What this screen reads for attention: a finish it has looked at reads idle here, and only here (#611).
  const sessions = useAttention(terminals, layout, narrow ? phoneOpen : null);
  const spaces = useSteady(useMemo(() => layoutSpaces(layouts, sessions, gitOf), [layouts, sessions, gitOf]));
  const onPalette = (): void => setPalette(true);
  const onSession: SessionVerb = (verb) => {
    const space = inView === null ? undefined : spaceOfAddress(spaces, inView);
    if (inView === null || (verb === "rename-space" && space === undefined)) return false;
    if (verb === "rename-space") setSpaceAsk(space?.id ?? null);
    else setAsk({ kind: verb, address: inView });
    return true;
  };
  const done = useCallback(() => {
    // The question is gone, answered or cancelled; a close that went ahead has already taken its move (closed).
    afterClose.current = null;
    setAsk(null);
  }, []);
  const pin = useCallback<PinTerminal>(
    (address, pinned) => {
      const labels = { [PIN_LABEL]: pinned ? "1" : "" };
      connection.call("terminal.label", { terminal: address, labels }).catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        toasts.add({ type: "error", title: pinned ? "Could not pin it" : "Could not unpin it", description: reason });
      });
    },
    [connection, toasts],
  );

  const openAddMachine = useCallback(() => setAdding(true), []);
  const terminalsLoaded = fed.loaded;
  const terminalsError = fed.loaded ? null : fed.error;
  const retryTerminals = fed.retry;
  const machinesListed = machineReads > 0 || listError !== undefined;
  useResumeEnds(connection, machinesListed ? views : undefined);
  // The sidebar's runs are its New space buttons: each terminal they start is the first tab of a new space (#404).
  const inNewSpace = useCallback(
    (address: string): void => {
      openInLayout(address, true);
      showOnPhone(address);
    },
    [openInLayout, showOnPhone],
  );
  // Read when a start is asked for, so the run is placed by that render's closure (see useMachineRuns), while the
  // machines context keeps its value across terminal events (#2086).
  const inNewSpaceNow = useRef(inNewSpace);
  inNewSpaceNow.current = inNewSpace;
  const machines = useMemo(
    () => ({
      entries,
      terminalsLoaded,
      terminalsError,
      retryTerminals,
      machinesListed,
      listError,
      openAddMachine,
      views,
      retry,
      remove,
      moveMachine,
      start: (params: TerminalRunParams) => runs.start(params, inNewSpaceNow.current),
      newTerminalOn: (machine: string) => runs.start({ on: machine }, inNewSpaceNow.current),
    }),
    [
      entries,
      terminalsLoaded,
      terminalsError,
      retryTerminals,
      machinesListed,
      listError,
      openAddMachine,
      views,
      retry,
      remove,
      moveMachine,
      runs,
    ],
  );
  const selectSpace = useStableCallback(layout.selectSpace);
  // The space keys count the spaces as the sidebar lists them, so "space 2" is the second row a person sees.
  const spaceKeys = useMemo(() => spacesInOrder(entries, spaces).map((space) => space.id), [entries, spaces]);
  const selectedSpace = layout.active?.spaceKey ?? null;
  const moveSpace = useSpaceMove(layouts, failed);
  // A phone's space row opens that space's screen (#1387); the desktop's selection is not the phone's, so none is marked.
  // Its rows count the tabs that screen lists, so a count there is the number of rows it heads (#2122); kept while
  // those counts hold, so the context does not change on every terminal event (#2086).
  const { showSpace } = phone;
  const counted = useSteady(
    useMemo(() => (narrow ? phoneSpaces(spaces, sessions) : spaces), [narrow, spaces, sessions]),
  );
  const spaceSelection = useMemo(
    () =>
      narrow
        ? { spaces: counted, selected: null, select: showSpace, move: moveSpace }
        : { spaces: counted, selected: selectedSpace, select: selectSpace, move: moveSpace },
    [narrow, counted, selectedSpace, selectSpace, showSpace, moveSpace],
  );
  // A space is known once the terminals and every layout document are read; until then its screen says it is loading.
  const spacesRead = fed.loaded && layout.restored;
  const listedSpace = phone.space === null ? undefined : spaces.find((each) => each.id === phone.space);
  const phoneSpace = phone.space === null ? null : (listedSpace ?? (spacesRead ? null : "loading"));
  const { dropSpace } = phone;
  const spaceGone = phone.space !== null && listedSpace === undefined && spacesRead;
  useEffect(() => {
    if (spaceGone) dropSpace();
  }, [spaceGone, dropSpace]);
  return (
    <MachinesContext value={machines}>
      <GitFactsContext value={gitOf}>
        <TodoProgressContext value={todoOf}>
          <SpaceSelectionContext value={spaceSelection}>
            <PinContext value={pin}>
              <SessionContext value={setAsk}>
                <SpaceRename
                  connection={connection}
                  terminals={terminals}
                  layouts={layouts}
                  spaces={spaces}
                  ask={spaceAsk}
                  onAsk={setSpaceAsk}
                >
                  <SpaceClose
                    connection={connection}
                    terminals={terminals}
                    layouts={layouts}
                    spaces={spaces}
                    ask={spaceClosing}
                    onAsk={setSpaceClosing}
                    drops={{ closing: closingSessions, kept }}
                    phone={narrow}
                  >
                    {narrow ? (
                      <PhoneShell
                        connection={connection}
                        terminals={sessions}
                        ids={ids}
                        open={phoneOpen}
                        space={phoneSpace}
                        panes={phonePanes}
                        tabTitle={phoneTitle}
                        // Back says where it goes: the space it was opened from, by name once the spaces are read (the chevron alone until then),
                        // else the Spaces list when it was opened from there.
                        backTo={
                          phone.space === null
                            ? phone.section === "spaces"
                              ? "Spaces"
                              : null
                            : (listedSpace?.name ?? "")
                        }
                        onOpen={showOnPhone}
                        onBack={phone.back}
                        onLeave={() => phone.leave(null)}
                        onSpaceBack={phone.backFromSpace}
                        pushed={phone.pushed}
                        section={phone.section}
                        onSection={phone.showSection}
                        onNew={() => newTerminal()}
                        newDisabled={newDisabled}
                        onNewInSpace={newTabIn}
                        onCloseTab={(address) => {
                          const found = findTerminal(layout.tabs, address);
                          if (found === null) return;
                          // Closing the tab the phone shows moves the phone on once the close goes ahead: to the tab
                          // that takes its place in the space, else up to the screen it came from (#1478).
                          const open = found.tab.panes.some((pane) => pane.address === phoneOpen) ? phoneOpen : null;
                          afterClose.current = null;
                          if (open !== null) {
                            // By every pane of the closing tab, not just the one in view: a split tab whose shown pane
                            // finished is still listed, under a live sibling's address.
                            const closingPanes = found.tab.panes.flatMap((pane) =>
                              pane.address === null ? [] : [pane.address],
                            );
                            const space = spaceOfAddress(spaces, open);
                            const next =
                              space === undefined ? null : nextAfterClosing(liveTabs(space, sessions), closingPanes);
                            afterClose.current = { key: found.tab.key, leave: () => phone.leave(next) };
                          }
                          closeTab(found.tab.key);
                        }}
                        sheet={phone.sheet}
                        onSheet={phone.showSheet}
                        onPalette={onPalette}
                        onSession={onSession}
                      />
                    ) : (
                      <DesktopShell
                        connection={connection}
                        terminals={sessions}
                        ids={ids}
                        loaded={fed.loaded}
                        layout={layout}
                        spaceKeys={spaceKeys}
                        onSelectSpace={selectSpace}
                        onNew={() => newTerminal()}
                        newDisabled={newDisabled}
                        onNewAgent={(template) => newTerminal(template)}
                        onNewSpace={() => runs.start({}, inNewSpace)}
                        onSplit={split}
                        onCloseTab={closeTab}
                        onCloseTabs={closeTabs}
                        onClosePane={closePane}
                        onEnd={onEnd}
                        onPalette={onPalette}
                        onSession={onSession}
                      />
                    )}
                  </SpaceClose>
                </SpaceRename>
              </SessionContext>
            </PinContext>
            <PromptAnswerBanner />
            <textarea
              ref={typeAhead.catcher}
              {...CATCHER_ATTRIBUTES}
              aria-label="New terminal starting: what you type goes to it"
              tabIndex={-1}
              className="sr-only"
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <AddMachineDialog
              open={adding}
              onClose={() => setAdding(false)}
              connection={connection}
              machines={entries}
            />
            <SessionDialogs
              connection={connection}
              views={views}
              terminals={terminals}
              ask={ask}
              onDone={done}
              onDrop={(address) => {
                // A tab's only pane closes as its tab (closeTab), so its drop is that tab's close going ahead.
                const found = findTerminal(layout.tabs, address);
                if (found !== null && found.tab.panes.length === 1) closed(found.tab.key);
                dropEnded(address);
              }}
              onKept={kept}
            />
            {closing === undefined ? null : (
              <CloseTabDialog
                key={closing.key}
                connection={connection}
                views={views}
                terminals={terminals}
                tab={closing}
                {...(lastOfSpace(closing)
                  ? { space: { name: spaces.find((space) => space.id === closing.spaceKey)?.name ?? "Space" } }
                  : {})}
                onClosed={() => {
                  closed(closing.key);
                  closingSessions(closing.panes.flatMap((pane) => (pane.address === null ? [] : [pane.address])));
                  layout.closeTab(closing.key);
                }}
                onDone={() => {
                  afterClose.current = null;
                  setClosingTab(null);
                }}
                onKept={kept}
              />
            )}
            {closingTabs.length === 0 || closingSetTab === undefined ? null : (
              <CloseTabDialog
                key={closingSet.join(" ")}
                connection={connection}
                views={views}
                terminals={terminals}
                tab={closingSetTab}
                tabs={closingTabs.length}
                onClosed={() => {
                  closingSessions(closingSetTab.panes.flatMap((pane) => (pane.address === null ? [] : [pane.address])));
                  for (const tab of closingTabs) layout.closeTab(tab.key);
                }}
                onDone={() => setClosingSet([])}
                onKept={kept}
              />
            )}
            {palette ? (
              <Palette
                terminals={sessions}
                spaces={spaces}
                host={connection.hello.core.name}
                route={connectionStore.settings.mode === "relay" ? "relay" : "loopback"}
                actions={availableActions(
                  narrow ? "phone" : "desktop",
                  inView !== null,
                  layout.active?.readOnly ?? null,
                  {
                    keys: layout.shown.map((tab) => tab.key),
                    active: layout.active?.key ?? null,
                  },
                  someoneElseNeedsYou(sessions, inView),
                )}
                onOpenTerminal={opened}
                onClose={() => setPalette(false)}
              />
            ) : null}
            <ShortcutsHelp />
          </SpaceSelectionContext>
        </TodoProgressContext>
      </GitFactsContext>
    </MachinesContext>
  );
}
