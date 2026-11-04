import type { HcConnection } from "@doriface/client";
import { IconButton, ScrollArea, StatusBar, StatusBarItem } from "@doriface/ui";
import { Link } from "@tanstack/react-router";
import { Monitor, Plus, Search, Settings } from "lucide-react";
import { connectionStore } from "../connection/store.ts";
import { NEW_TAB } from "../keys/actions.ts";
import { AgentLists } from "./agent-lists.tsx";
import { onlyThisMachine } from "./machines.ts";
import type { Session } from "./model.ts";
import { ReconnectStatus } from "./reconnect-status.tsx";
import { PhoneEmpty } from "./phone-empty.tsx";
import { PhoneTerminal } from "./phone-terminal.tsx";
import { RovingLists } from "./roving-lists.tsx";
import { usePhoneActions, type SessionVerb } from "./use-app-actions.ts";
import { useMachinesContext } from "./use-machines.ts";

export interface PhoneShellProps {
  readonly connection: HcConnection;
  readonly terminals: readonly Session[];
  readonly open: string | null;
  readonly onOpen: (address: string) => void;
  readonly onBack: () => void;
  readonly onNew: () => void;
  readonly onPalette: () => void;
  readonly onSession: SessionVerb;
}

/** Phones: the agents list first; opening one shows its terminal full screen with extra keys. */
export function PhoneShell(props: PhoneShellProps) {
  const { connection, terminals, open, onOpen, onBack, onNew, onPalette, onSession } = props;
  usePhoneActions(onNew, onSession);
  const machines = useMachinesContext();
  const terminal = terminals.find((entry) => entry.address === open);
  const empty = !terminals.some((entry) => entry.state === "live");
  if (terminal === undefined) {
    const route = connectionStore.settings.mode === "relay" ? "relay" : "loopback";
    return (
      <div className="flex h-dvh min-h-0 min-w-0 flex-col bg-sidebar">
        <header
          data-titlebar
          className="flex h-12 shrink-0 items-center gap-1 pt-[env(safe-area-inset-top)] pr-4 pl-[var(--titlebar-inset-start,1rem)]"
        >
          <h1 className="flex-1 text-xl font-semibold text-foreground">Agents</h1>
          <IconButton label="Command palette" icon={<Search />} size="md" onClick={onPalette} />
          <IconButton label={NEW_TAB.label} icon={<Plus />} size="md" onClick={onNew} />
          <IconButton label="Settings" icon={<Settings />} size="md" render={<Link to="/settings" />} />
        </header>
        <ScrollArea slot="agents-list" className="flex-1">
          {empty ? (
            <PhoneEmpty host={connection.hello.core.name} onNew={onNew} onAddMachine={machines.openAddMachine} />
          ) : null}
          {empty && onlyThisMachine(machines.entries) ? null : (
            <RovingLists>
              <AgentLists terminals={terminals} active={null} onOpen={onOpen} agentsFirst />
            </RovingLists>
          )}
        </ScrollArea>
        <StatusBar
          start={
            <>
              <StatusBarItem icon={<Monitor aria-hidden />}>{`${connection.hello.core.name} · ${route}`}</StatusBarItem>
              <ReconnectStatus />
            </>
          }
        />
      </div>
    );
  }
  return (
    <PhoneTerminal connection={connection} terminal={terminal} terminals={terminals} onOpen={onOpen} onBack={onBack} />
  );
}
