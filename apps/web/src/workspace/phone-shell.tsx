import type { HcConnection } from "@doriface/client";
import { IconButton, ScrollArea, StatusBar, StatusBarItem } from "@doriface/ui";
import { Link } from "@tanstack/react-router";
import { Monitor, Plus, Search, Settings } from "lucide-react";
import { useRef } from "react";
import { connectionStore } from "../connection/store.ts";
import { NEW_TAB } from "../keys/actions.ts";
import { AgentLists } from "./agent-lists.tsx";
import { onlyThisMachine } from "./machines.ts";
import type { Session } from "./model.ts";
import { ConnectionLine, ConnectionPathItem, ReconnectStatus } from "./reconnect-status.tsx";
import { usePendingUpdate } from "../update/update-store.ts";
import { FirstRunGuideCard } from "../pair/first-run-guide-card.tsx";
import { PhoneEmpty } from "./phone-empty.tsx";
import { PhoneListLoading } from "./phone-loading.tsx";
import { PhoneTerminal } from "./phone-terminal.tsx";
import { RovingLists } from "./roving-lists.tsx";
import { usePhoneActions, type SessionVerb } from "./use-app-actions.ts";
import { useMachinesContext } from "./use-machines.ts";

export interface PhoneShellProps {
  readonly connection: HcConnection;
  readonly terminals: readonly Session[];
  readonly open: string | null;
  /** The terminals of the tab that shows the open one, in its panes' order; one when that tab is not split. */
  readonly panes: readonly string[];
  /** The open terminal's tab as the strip reads it (its name, else its number); null when it is in no tab. */
  readonly tabTitle: string | null;
  readonly onOpen: (address: string) => void;
  readonly onBack: () => void;
  readonly onNew: () => void;
  readonly onPalette: () => void;
  readonly onSession: SessionVerb;
}

/** Phones: the agents list first; opening one shows its terminal full screen with extra keys. */
export function PhoneShell(props: PhoneShellProps) {
  const { connection, terminals, open, panes, tabTitle, onOpen, onBack, onNew, onPalette, onSession } = props;
  // The open terminal registers its dictation here, so the palette and a bound key reach it from this shell's handler.
  const dictate = useRef<(() => void) | null>(null);
  usePhoneActions(onNew, onSession, () => (dictate.current === null ? false : (dictate.current(), true)));
  const machines = useMachinesContext();
  const update = usePendingUpdate();
  const terminal = terminals.find((entry) => entry.address === open);
  // An unanswered list is not an empty one: the empty state waits for the core's first answer (#797).
  const empty = machines.terminalsLoaded && !terminals.some((entry) => entry.state === "live");
  if (terminal === undefined) {
    const route = connectionStore.settings.mode === "relay" ? "relay" : "loopback";
    return (
      <div className="flex h-dvh min-h-0 min-w-0 flex-col bg-sidebar pr-(--safe-right) pl-(--safe-left)">
        <header
          data-titlebar
          className="flex h-[calc(3rem+var(--safe-top))] shrink-0 items-center gap-1 pt-(--safe-top) pr-4 pl-[var(--titlebar-inset-start,1rem)]"
        >
          <h1 className="flex-1 text-xl font-semibold text-foreground">Agents</h1>
          <IconButton label="Command palette" icon={<Search />} size="md" onClick={onPalette} />
          <IconButton label={NEW_TAB.label} icon={<Plus />} size="md" onClick={onNew} />
          <IconButton
            label={update === null ? "Settings" : "Settings, update ready"}
            icon={
              <>
                <Settings />
                {update === null ? null : (
                  <span
                    aria-hidden
                    data-slot="settings-dot"
                    className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-brand"
                  />
                )}
              </>
            }
            size="md"
            className="relative"
            render={<Link to="/settings" />}
          />
        </header>
        <ConnectionLine />
        <ScrollArea slot="agents-list" className="flex-1">
          <FirstRunGuideCard listVisible listedLive={!empty} onNew={onNew} />
          {machines.terminalsLoaded ? (
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
          ) : (
            <PhoneListLoading />
          )}
        </ScrollArea>
        <StatusBar
          className="h-[calc(var(--statusbar-height)+var(--safe-bottom))] pb-(--safe-bottom)"
          start={
            <>
              <StatusBarItem icon={<Monitor aria-hidden />}>{`${connection.hello.core.name} · ${route}`}</StatusBarItem>
              <ConnectionPathItem />
              <ReconnectStatus compact />
            </>
          }
        />
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
      onOpen={onOpen}
      onBack={onBack}
      dictate={dictate}
    />
  );
}
