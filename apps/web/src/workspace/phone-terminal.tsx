import type { HcConnection } from "@doriface/client";
import { IconButton, StatusChip } from "@doriface/ui";
import { ChevronLeft } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useSoftKeyboard } from "../terminal/keyboard-inset.ts";
import { hostPlatform } from "../terminal/keys.ts";
import { closesTab } from "../terminal/terminal-end.ts";
import type { TerminalPort } from "../terminal/terminal-port.ts";
import { TerminalView } from "../terminal/terminal-view.tsx";
import { MachineOffline } from "./machine-offline.tsx";
import { agentStatus, machineOf, type Session, spaceName, terminalTitle } from "./model.ts";
import { KEYS_BAR_HEIGHT, keysBottom, PhoneKeys } from "./phone-keys.tsx";
import { ConnectionLine } from "./reconnect-status.tsx";
import { afterEnd } from "./session-actions.ts";
import { SessionMenu } from "./session-menu.tsx";
import { useStickyKeys } from "./use-sticky-keys.ts";

export interface PhoneTerminalProps {
  readonly connection: HcConnection;
  readonly terminal: Session;
  readonly terminals: readonly Session[];
  readonly onOpen: (address: string) => void;
  readonly onBack: () => void;
}

/** One session full screen on a phone, its terminal kept clear of the soft keyboard and the keys bar riding on it. */
export function PhoneTerminal({ connection, terminal, terminals, onOpen, onBack }: PhoneTerminalProps) {
  const port = useRef<TerminalPort | null>(null);
  const onPort = useCallback((next: TerminalPort | null) => {
    port.current = next;
  }, []);
  const [scope, setScope] = useState<HTMLDivElement | null>(null);
  const keyboard = useSoftKeyboard(scope);
  const [menu, setMenu] = useState(false);
  const title = terminalTitle(terminal);
  const machine = machineOf(terminal.address);
  const where = machine === undefined ? spaceName(terminal) : `${machine} · ${spaceName(terminal)}`;
  const host = hostPlatform(machine ?? connection.hello.core.name);
  const sticky = useStickyKeys(port, host);
  const offline = terminal.offline === true && machine !== undefined;
  const keysOpen = keyboard.up || menu;

  return (
    <div className="relative flex h-dvh min-h-0 flex-col bg-card">
      <header
        data-titlebar
        className="flex min-h-12 shrink-0 items-center gap-1 border-b border-border bg-chrome pt-[env(safe-area-inset-top)] pr-1.5 pl-[var(--titlebar-inset-start,0.375rem)]"
      >
        <IconButton label="Back to agents" icon={<ChevronLeft />} size="md" onClick={onBack} />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            <h1 title={title} className="min-w-0 truncate text-base leading-tight font-semibold text-foreground">
              {title}
            </h1>
            <StatusChip status={agentStatus(terminal)} />
          </div>
          <p title={where} className="truncate text-xs leading-tight text-muted-foreground">
            {where}
          </p>
        </div>
        <SessionMenu address={terminal.address} title={title} placement="header" />
      </header>
      <ConnectionLine />
      <div
        ref={setScope}
        className="flex min-h-0 flex-1 flex-col"
        style={keysOpen ? { paddingBottom: `calc(${keysBottom(keyboard.inset)} + ${KEYS_BAR_HEIGHT})` } : undefined}
      >
        {offline ? (
          <MachineOffline machine={machine} />
        ) : (
          <TerminalView
            // A rename moves the address, a restarted program changes the pid: either way the view attaches afresh.
            key={`${terminal.address}#${terminal.pid ?? ""}`}
            connection={connection}
            address={terminal.address}
            pid={terminal.pid ?? null}
            live={terminal.state === "live"}
            focused
            label={`${title} output`}
            transformInput={sticky.transform}
            onPort={onPort}
            // An End of this session leaves the screen only once it has removed the terminal (see afterEnd).
            onEnd={(address, end) => (closesTab(end) ? afterEnd(address, onBack) : undefined)}
          />
        )}
      </div>
      {offline ? null : (
        <PhoneKeys
          port={port}
          open={keysOpen}
          inset={keyboard.inset}
          host={host}
          sticky={sticky}
          terminals={terminals}
          current={terminal.address}
          onOpen={onOpen}
          onMenu={setMenu}
        />
      )}
    </div>
  );
}
