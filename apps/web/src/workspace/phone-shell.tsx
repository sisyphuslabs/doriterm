import type { HcConnection } from "@doriface/client";
import { IconButton, ScrollArea, StatusBar, StatusBarItem } from "@doriface/ui";
import { Monitor, Plus, Search } from "lucide-react";
import { useRef } from "react";
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
import type { MachineIds } from "./tab-keys.ts";

export interface PhoneShellProps {
  readonly connection: HcConnection;
  readonly terminals: readonly Session[];
  /** The machines as now named, so the first-run guide finds its terminal after a rename (#1198). */
  readonly ids: MachineIds;
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
  /** Leaves the open terminal for the screen it came from, past the switch sheet when it is open (#1478). */
  readonly onLeave: () => void;
  /** Where the open terminal's Back goes when that is a space (its name); null when it goes to the agents list. */
  readonly backTo: string | null;
  /** The space screen's Back, to the list. */
  readonly onSpaceBack: () => void;
  readonly onNew: () => void;
  /** The new tab's machine is not reachable now: its + stays in place, disabled. */
  readonly newDisabled: boolean;
  /** Starts a new tab in the space with this key and opens it. */
  readonly onNewInSpace: (key: string) => void;
  /** Closes the tab that shows this terminal, as the desktop strip's close does. */
  readonly onCloseTab: (address: string) => void;
  /** Whether the switch sheet is open over the open terminal, and its opening and closing (the route holds it). */
  readonly sheet: boolean;
  readonly onSheet: (open: boolean) => void;
  readonly onPalette: () => void;
  readonly onSession: SessionVerb;
}

/** Phones: the agents list first; a space opens its own screen, and a terminal shows full screen with extra keys. */
export function PhoneShell(props: PhoneShellProps) {
  const { connection, terminals, open, space, panes, tabTitle, onOpen, onBack, onNew, onNewInSpace, onPalette } = props;
  const { onSession, onSpaceBack, onCloseTab, onLeave, pushed, backTo, section, onSection, sheet, onSheet, ids } =
    props;
  // The open terminal registers its dictation here, so the palette and a bound key reach it from this shell's handler.
  const dictate = useRef<(() => void) | null>(null);
  usePhoneActions(onNew, onSession, () => (dictate.current === null ? false : (dictate.current(), true)));
  const machines = useMachinesContext();
  const terminal = terminals.find((entry) => entry.address === open);
  // The terminal the phone shows now, for callbacks that settle after the render that made them (onEnded).
  const openNow = useRef(open);
  openNow.current = open;
  // The leave of this render, for the same reason: an End settles about one RPC after the render that registered it, and
  // a switch sheet opened or closed meanwhile changes how the phone leaves (#2177).
  const leaveNow = useRef(onLeave);
  leaveNow.current = onLeave;
  // An unanswered list is not an empty one: the empty state waits for the core's first answer (#797).
  const live = machines.terminalsLoaded
    ? terminals.filter((entry) => entry.state === "live").map((entry) => entry.address)
    : [];
  const empty = machines.terminalsLoaded && live.length === 0;
  // A screen pushed after the first loaded paint arrives with motion (DESIGN.md 6); the first screen does not.
  useArrivalReady(machines.terminalsLoaded);
  // The list is unmounted while a terminal is open; Back brings it back where it was, not at the top (#1553).
  // Agents and Spaces scroll in the same frame: each keeps its own place, by its section (#1553).
  const listViewport = useKeptScroll(section, machines.terminalsLoaded && terminal === undefined && space === null);
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
          <IconButton label={NEW_TAB.label} icon={<Plus />} size="md" disabled={props.newDisabled} onClick={onNew} />
        </header>
        <ConnectionLine />
        {/* The page's one main landmark: the list, under the header (#1378). */}
        <main className="flex min-h-0 flex-1 flex-col">
          <ScrollArea slot="agents-list" className="flex-1" viewportRef={listViewport}>
            <FirstRunGuideCard listVisible live={live} ids={ids} onNew={onNew} newDisabled={props.newDisabled} />
            {section === "spaces" ? (
              <RovingLists>
                <PhoneSpaceLists onOpen={onOpen} />
              </RovingLists>
            ) : machines.terminalsLoaded ? (
              <>
                {empty ? (
                  <PhoneEmpty
                    host={connection.hello.core.name}
                    onNew={onNew}
                    newDisabled={props.newDisabled}
                    onAddMachine={machines.openAddMachine}
                  />
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
      onBack={onBack}
      onEnded={(address) => {
        // Read at the moment the End settles, not at the render that registered it: by then a close from the sheet may
        // have moved the phone to the tab that took its place, and that move stands (#1478).
        if (openNow.current !== address) return;
        leaveNow.current();
      }}
      onCloseTab={onCloseTab}
      onNewInSpace={onNewInSpace}
      sheet={sheet}
      onSheet={onSheet}
      dictate={dictate}
    />
  );
}
