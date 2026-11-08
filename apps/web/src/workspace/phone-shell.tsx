import type { HcConnection } from "@doriface/client";
import { IconButton, ScrollArea, StatusBar, StatusBarItem } from "@doriface/ui";
import { Monitor, Plus, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { connectionStore } from "../connection/store.ts";
import { NEW_TAB } from "../keys/actions.ts";
import { AgentLists, PhoneSpaceLists } from "./agent-lists.tsx";
import { PhoneSortMenu } from "./agents-group.tsx";
import { onlyThisMachine } from "./machines.ts";
import type { ListedSpace, Session } from "./model.ts";
import { PhoneSpace, PhoneSpaceLoading } from "./phone-space.tsx";
import { useArrivalReady } from "./use-arrival-ready.ts";
import { useKeptScroll } from "./kept-scroll.ts";
import { ConnectionLine, ConnectionPathItem, ReconnectStatus } from "./reconnect-status.tsx";
import type { PhoneSection } from "./phone-route.ts";
import { PhoneTabBar } from "./phone-tab-bar.tsx";
import { FirstRunGuideCard } from "../pair/first-run-guide-card.tsx";
import { PhoneEmpty } from "./phone-empty.tsx";
import { PhoneListLoading } from "./phone-loading.tsx";
import { TerminalsLoadError } from "./terminals-load-error.tsx";
import { PhoneTerminal } from "./phone-terminal.tsx";
import { RovingLists } from "./roving-lists.tsx";
import { usePhoneActions, type SessionVerb } from "./use-app-actions.ts";
import { useMachinesContext } from "./use-machines.ts";

export interface PhoneShellProps {
  readonly connection: HcConnection;
  readonly terminals: readonly Session[];
  readonly open: string | null;
  /**
   * The space whose screen shows under the open terminal, or on its own when none is open; "loading" while the space the
   * address names is not read yet; null for the list.
   */
  readonly space: ListedSpace | "loading" | null;
  /** Whether the screen in view was reached by a push, the only arrival a pushed screen slides in for. */
  readonly pushed: boolean;
  /** The list the phone shows, its bottom tab bar's current tab; a space screen's Back goes to it. */
  readonly section: PhoneSection;
  readonly onSection: (section: PhoneSection) => void;
  /** The terminals of the tab that shows the open one, in its panes' order; one when that tab is not split. */
  readonly panes: readonly string[];
  /** The open terminal's tab as the strip reads it (its name, else its number); null when it is in no tab. */
  readonly tabTitle: string | null;
  readonly onOpen: (address: string) => void;
  readonly onBack: () => void;
  /** Where the open terminal's Back goes when that is a space (its name); null when it goes to the agents list. */
  readonly backTo: string | null;
  /** The space screen's Back, to the list. */
  readonly onSpaceBack: () => void;
  readonly onNew: () => void;
  /** Starts a new tab in the space with this key and opens it. */
  readonly onNewInSpace: (key: string) => void;
  /** Closes the tab that shows this terminal, as the desktop strip's close does. */
  readonly onCloseTab: (address: string) => void;
  readonly onPalette: () => void;
  readonly onSession: SessionVerb;
}

/** Phones: the agents list first; a space opens its own screen, and a terminal shows full screen with extra keys. */
export function PhoneShell(props: PhoneShellProps) {
  const { connection, terminals, open, space, panes, tabTitle, onOpen, onBack, onNew, onNewInSpace, onPalette } = props;
  const { onSession, onSpaceBack, onCloseTab, pushed, backTo, section, onSection } = props;
  // The open terminal registers its dictation here, so the palette and a bound key reach it from this shell's handler.
  const dictate = useRef<(() => void) | null>(null);
  usePhoneActions(onNew, onSession, () => (dictate.current === null ? false : (dictate.current(), true)));
  const machines = useMachinesContext();
  const terminal = terminals.find((entry) => entry.address === open);
  // A session picked from the keys bar is the person asking for its keyboard: its view takes the keyboard as it opens.
  // The ask is answered once that keyboard is up, and it ends when the session is left by any route (the app's Back, the
  // system Back, the tabs bar, the list), so a later reopen or re-attach of that session raises nothing (#1375).
  const [picked, setPicked] = useState<string | null>(null);
  const shown = terminal?.address ?? null;
  const lastShown = useRef(shown);
  useEffect(() => {
    if (shown !== lastShown.current && shown !== picked) setPicked(null);
    lastShown.current = shown;
  }, [shown, picked]);
  // An unanswered list is not an empty one: the empty state waits for the core's first answer (#797).
  const live = machines.terminalsLoaded
    ? terminals.filter((entry) => entry.state === "live").map((entry) => entry.address)
    : [];
  const empty = machines.terminalsLoaded && live.length === 0;
  // A screen pushed after the first loaded paint arrives with motion (DESIGN.md 6); the first screen does not.
  useArrivalReady(machines.terminalsLoaded);
  // The list is unmounted while a terminal is open; Back brings it back where it was, not at the top (#1553).
  const listViewport = useKeptScroll("agents", machines.terminalsLoaded && terminal === undefined && space === null);
  // A space's rows are its live terminals: until the terminals are listed (or when that failed) the screen says so,
  // never "Nothing is running".
  if (terminal === undefined && (space === "loading" || (space !== null && !machines.terminalsLoaded)))
    return (
      <PhoneSpaceLoading
        error={machines.terminalsError}
        onRetry={machines.retryTerminals}
        from={section}
        onBack={onSpaceBack}
      />
    );
  if (terminal === undefined && space !== null && space !== "loading") {
    return (
      <PhoneSpace
        space={space}
        terminals={terminals}
        host={connection.hello.core.name}
        arrive={pushed}
        from={section}
        onOpen={onOpen}
        onBack={onSpaceBack}
        onNew={() => onNewInSpace(space.id)}
      />
    );
  }
  if (terminal === undefined) {
    return (
      <div className="flex h-dvh min-h-0 min-w-0 flex-col bg-sidebar pr-(--safe-right) pl-(--safe-left)">
        <header
          data-titlebar
          className="flex h-[calc(3rem+var(--safe-top))] shrink-0 items-center gap-1 pt-(--safe-top) pr-4 pl-[var(--titlebar-inset-start,1rem)]"
        >
          <h1 className="flex-1 text-xl font-semibold text-foreground">{section === "agents" ? "Agents" : "Spaces"}</h1>
          <IconButton label="Command palette" icon={<Search />} size="md" onClick={onPalette} />
          {machines.terminalsLoaded && section === "agents" ? <PhoneSortMenu terminals={terminals} /> : null}
          <IconButton label={NEW_TAB.label} icon={<Plus />} size="md" onClick={onNew} />
        </header>
        <ConnectionLine />
        {/* The page's one main landmark: the list, under the header (#1378). */}
        <main className="flex min-h-0 flex-1 flex-col">
          <ScrollArea slot="agents-list" className="flex-1" viewportRef={listViewport}>
            <FirstRunGuideCard listVisible live={live} onNew={onNew} />
            {section === "spaces" ? (
              <RovingLists>
                <PhoneSpaceLists onOpen={onOpen} />
              </RovingLists>
            ) : machines.terminalsLoaded ? (
              <>
                {empty ? (
                  <PhoneEmpty host={connection.hello.core.name} onNew={onNew} onAddMachine={machines.openAddMachine} />
                ) : null}
                {empty && onlyThisMachine(machines.entries) ? null : (
                  <RovingLists>
                    <AgentLists terminals={terminals} active={null} onOpen={onOpen} heading={false} />
                  </RovingLists>
                )}
              </>
            ) : machines.terminalsError !== null ? (
              <TerminalsLoadError cause={machines.terminalsError} onRetry={machines.retryTerminals} />
            ) : (
              <PhoneListLoading />
            )}
          </ScrollArea>
        </main>
        {/*
          The machines' list carries how this device reaches them: the core, the path (Relay or Direct) and a reconnect in
          progress. The agents list leaves that to the connection line under its header.
        */}
        {section === "spaces" ? (
          <StatusBar
            start={
              <>
                <StatusBarItem icon={<Monitor aria-hidden />}>
                  {`${connection.hello.core.name} · ${connectionStore.settings.mode === "relay" ? "relay" : "loopback"}`}
                </StatusBarItem>
                <ConnectionPathItem />
                <ReconnectStatus compact />
              </>
            }
          />
        ) : null}
        <PhoneTabBar section={section} terminals={terminals} onSection={onSection} />
      </div>
    );
  }
  return (
    // Keyed by session: a switch starts with no latched modifier, no open pad and no open menu.
    <PhoneTerminal
      key={terminal.address}
      connection={connection}
      terminal={terminal}
      terminals={terminals}
      panes={panes}
      tabTitle={tabTitle}
      backTo={backTo}
      onOpen={onOpen}
      onBack={() => {
        setPicked(null);
        onBack();
      }}
      onCloseTab={onCloseTab}
      onNewInSpace={onNewInSpace}
      dictate={dictate}
      claimed={picked === terminal.address}
      onClaimed={() => setPicked(null)}
      onPick={(address) => {
        setPicked(address);
        onOpen(address);
      }}
    />
  );
}
