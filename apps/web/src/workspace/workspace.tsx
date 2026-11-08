import type { TerminalRunParams } from "@doriface/protocol";
import type { HcConnection } from "@doriface/client";
import { useToastManager } from "@doriface/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { connectionStore } from "../connection/store.ts";
import { useActionHandler } from "../keys/dispatcher.ts";
import { ShortcutsHelp } from "../keys/shortcuts-dialog.tsx";
import { type Axis, LAYOUT_DOC, ORDER_DOC } from "@doriface/protocol/layout";
import { closesTab, type TerminalEnd } from "../terminal/terminal-end.ts";
import { CloseTabDialog } from "./close-tab-dialog.tsx";
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
import type { SessionVerb } from "./use-app-actions.ts";
import { useMachineRuns } from "./use-machine-runs.ts";
import { PIN_LABEL, spacesInOrder } from "./sidebar-model.ts";
import { PinContext, type PinTerminal } from "./use-pin.ts";
import { MachinesContext, useMachines } from "./use-machines.ts";
import { runParamsFor } from "./new-terminal.ts";
import { useNarrow } from "./use-narrow.ts";
import { machineIds } from "./tab-keys.ts";
import { findTerminal, type LayoutTab } from "./layout-model.ts";
import { useLayout, type PaneTarget } from "./use-layout.ts";
import { chainedSplit, SplitChain } from "./split-chain.ts";
import { afterEnd } from "./session-actions.ts";
import { useDeadPanes } from "./use-dead-panes.ts";
import { useDropOnce } from "./use-drop-once.ts";
import { useLayoutDocs } from "./use-layout-docs.ts";
import { GitFactsContext, useGitFacts } from "./git-facts.ts";
import { TodoProgressContext, useTodoProgress } from "./todo-progress.ts";
import { layoutSpaces, phoneTabTitle } from "./model.ts";
import { SpaceSelectionContext } from "./space-selection.ts";
import { useSpaceMove } from "./space-order.ts";
import { useAdoptLoose } from "./use-adopt-loose.ts";
import { useAttention } from "./use-attention.ts";
import { orderNotSaved } from "./machine-order.ts";
import { useMachineOrder } from "./use-machine-order.ts";
import { useTerminals, type DocHeard } from "./use-terminals.ts";
import { useResumeEnds } from "./resume-ends.ts";
import { useNoticeOpen } from "../push/notice-open.ts";
import { usePushPresence } from "../push/use-push-presence.ts";
import { PromptAnswerBanner } from "../push/prompt-answer-banner.tsx";
import { CATCHER_ATTRIBUTES, type DropReason, useTypeAhead } from "./use-type-ahead.ts";

export interface WorkspaceProps {
  readonly connection: HcConnection;
}

/** The live terminals of one core: the desktop shell from `md` up, the phone navigation below. */
export function Workspace({ connection }: WorkspaceProps) {
  // The feed comes before the machine list the layout documents need, so its doc events reach them through a ref.
  const heardLayout = useRef<(machine: string | null, version: number) => void>(() => undefined);
  const heardOrder = useRef<(version: number) => void>(() => undefined);
  const onDoc = useCallback<DocHeard>((machine, name, version) => {
    if (name === LAYOUT_DOC) heardLayout.current(machine, version);
    if (name === ORDER_DOC && machine === null) heardOrder.current(version);
  }, []);
  const fed = useTerminals(connection, onDoc);
  useResumeEnds(connection);
  const {
    entries: listed,
    terminals,
    refresh,
    listError,
    views,
    heard: heardMachines,
    retry,
    listed: machineReads,
  } = useMachines(connection, fed.terminals);
  // Opened and re-read on what hc said: a document read while its line was down is read again once the line is back.
  const { layouts, heard } = useLayoutDocs(connection, heardMachines, views);
  const gitOf = useGitFacts(connection, views);
  const todoOf = useTodoProgress(connection, fed.terminals);
  heardLayout.current = heard;
  const order = useMachineOrder(connection, listed);
  heardOrder.current = order.heard;
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
  const { dropEnded, closing: closingSessions, kept } = useDropOnce(terminals, layout.dropPane);
  // A pane is asked about only on what hc said: a machine held connected through a redial may have no terminals listed.
  useDeadPanes(connection, layout.tabs, fed.loaded ? terminals : null, heardMachines, machineReads, dropEnded);
  useAdoptLoose(layouts, fed.loaded ? terminals : null, failed);
  const narrow = useNarrow();
  const ids = useMemo(() => machineIds(views), [views]);
  const phone = usePhoneRoute(narrow, ids);
  const { open: phoneOpen, show: showOnPhone } = phone;
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
  const runs = useMachineRuns(connection, opened, refresh, typeAhead);
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
        guideStore.opened(address);
        opened(address);
      },
    );
  };
  // The latest `opened`: a tab started from a space screen is placed once that space is the selected one (addTab's `near`).
  const openedNow = useRef(opened);
  openedNow.current = opened;
  const newTabIn = (key: string): void => {
    const space = spaces.find((each) => each.id === key);
    const near = terminals.find((terminal) => terminal.state === "live" && space?.addresses.includes(terminal.address));
    layout.selectSpace(key);
    runs.start(runParamsFor(near, space), (address) => {
      guideStore.opened(address);
      openedNow.current(address);
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
  const closeTab = (key: string): void => {
    const tab = layout.tabs.find((each) => each.key === key);
    if (lastOfSpace(tab)) return setClosingTab(key);
    const shown = tab?.panes.flatMap((pane) => (pane.address === null ? [] : [pane.address])) ?? [];
    const [only] = shown;
    if (shown.length === 1 && only !== undefined) setAsk({ kind: "close", address: only });
    else if (shown.length > 1) setClosingTab(key);
    else layout.closeTab(key);
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
  const phoneTab = phoneOpen === null ? null : findTerminal(layout.tabs, phoneOpen);
  const phonePanes = phoneTab?.tab.panes.flatMap((pane) => (pane.address === null ? [] : [pane.address])) ?? [];
  const phoneTitle = phoneTab === null ? null : phoneTabTitle(phoneTab.tab.name);
  usePushPresence(inView);
  useNoticeOpen(connectionStore.settings.mode === "relay" ? connectionStore.settings.hostId : undefined, opened);
  // What this screen reads for attention: a finish it has looked at reads idle here, and only here (#611).
  const sessions = useAttention(terminals, layout, narrow ? phoneOpen : null);
  const spaces = useMemo(() => layoutSpaces(layouts, sessions, gitOf), [layouts, sessions, gitOf]);
  const onPalette = (): void => setPalette(true);
  const onSession: SessionVerb = (verb) => {
    const space = spaces.find((each) => inView !== null && each.addresses.includes(inView));
    if (inView === null || (verb === "rename-space" && space === undefined)) return false;
    if (verb === "rename-space") setSpaceAsk(space?.id ?? null);
    else setAsk({ kind: verb, address: inView });
    return true;
  };
  const done = useCallback(() => setAsk(null), []);
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
  // The sidebar's runs are its New space buttons: each terminal they start is the first tab of a new space (#404).
  const inNewSpace = useCallback(
    (address: string): void => {
      openInLayout(address, true);
      showOnPhone(address);
    },
    [openInLayout, showOnPhone],
  );
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
      moveMachine,
      start: (params: TerminalRunParams) => runs.start(params, inNewSpace),
      newTerminalOn: (machine: string) => runs.start({ on: machine }, inNewSpace),
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
      moveMachine,
      runs,
      inNewSpace,
    ],
  );
  const { selectSpace } = layout;
  // The space keys count the spaces as the sidebar lists them, so "space 2" is the second row a person sees.
  const spaceKeys = useMemo(() => spacesInOrder(entries, spaces).map((space) => space.id), [entries, spaces]);
  const selectedSpace = layout.active?.spaceKey ?? null;
  const moveSpace = useSpaceMove(layouts, failed);
  // A phone's space row opens that space's screen (#1387); the desktop's selection is not the phone's, so none is marked.
  const { showSpace } = phone;
  const spaceSelection = useMemo(
    () =>
      narrow
        ? { spaces, selected: null, select: showSpace, move: moveSpace }
        : { spaces, selected: selectedSpace, select: selectSpace, move: moveSpace },
    [narrow, spaces, selectedSpace, selectSpace, showSpace, moveSpace],
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
                  >
                    {narrow ? (
                      <PhoneShell
                        connection={connection}
                        terminals={sessions}
                        open={phoneOpen}
                        space={phoneSpace}
                        panes={phonePanes}
                        tabTitle={phoneTitle}
                        // Back says where it goes: the space it was opened from, by name once the spaces are read ("space" until then),
                        // else the Spaces list when it was opened from there.
                        backTo={
                          phone.space === null
                            ? phone.section === "spaces"
                              ? "Spaces"
                              : null
                            : (listedSpace?.name ?? "space")
                        }
                        onOpen={showOnPhone}
                        onBack={phone.back}
                        onSpaceBack={phone.backFromSpace}
                        pushed={phone.pushed}
                        section={phone.section}
                        onSection={phone.showSection}
                        onNew={() => newTerminal()}
                        onNewInSpace={newTabIn}
                        onCloseTab={(address) => {
                          const found = findTerminal(layout.tabs, address);
                          if (found !== null) closeTab(found.tab.key);
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
                        loaded={fed.loaded}
                        layout={layout}
                        spaceKeys={spaceKeys}
                        onSelectSpace={selectSpace}
                        onNew={() => newTerminal()}
                        onNewAgent={(template) => newTerminal(template)}
                        onNewSpace={() => runs.start({}, inNewSpace)}
                        onSplit={split}
                        onCloseTab={closeTab}
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
              terminals={terminals}
              ask={ask}
              onDone={done}
              onDrop={dropEnded}
              onKept={kept}
            />
            {closing === undefined ? null : (
              <CloseTabDialog
                key={closing.key}
                connection={connection}
                terminals={terminals}
                tab={closing}
                {...(lastOfSpace(closing)
                  ? { space: { name: spaces.find((space) => space.id === closing.spaceKey)?.name ?? "Space" } }
                  : {})}
                onClosed={() => {
                  closingSessions(closing.panes.flatMap((pane) => (pane.address === null ? [] : [pane.address])));
                  layout.closeTab(closing.key);
                }}
                onDone={() => setClosingTab(null)}
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
