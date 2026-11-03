import { Button, IconButton, Notice, SidebarSection, cn } from "@doriface/ui";
import { Monitor, Plus, Server } from "lucide-react";
import { type MachineEntry, stateLabel } from "./machines.ts";
import type { RunFailure } from "./start-on.ts";

export interface MachineListProps {
  readonly entries: readonly MachineEntry[];
  /** The id of the machine the active terminal is on. */
  readonly activeMachine: string | undefined;
  readonly onOpen: (address: string) => void;
  readonly onNewOn: (machine: string) => void;
  readonly failure?: RunFailure | undefined;
  readonly listError?: string | undefined;
  readonly onDismiss?: () => void;
  readonly className?: string;
}

const STATE_TONE: Readonly<Record<string, string>> = {
  unreachable: "text-status-blocked-text",
  needs_login: "text-status-blocked-text",
};

/** Every machine this core reaches: this one, then the ones `hc machine add` added, with state and terminals. */
export function MachineList({
  entries,
  activeMachine,
  onOpen,
  onNewOn,
  failure,
  listError,
  onDismiss,
  className,
}: MachineListProps) {
  return (
    <SidebarSection title="Machines" count={entries.length} {...(className === undefined ? {} : { className })}>
      {entries.map((machine) => {
        const Icon = machine.local ? Monitor : Server;
        const selected = machine.id === activeMachine;
        const state = machine.local ? "this machine" : stateLabel(machine.state);
        const dim = machine.first === undefined && "opacity-45";
        return (
          <div
            key={machine.id}
            className={cn(
              "group flex h-(--row) min-w-0 items-center rounded-md",
              machine.first !== undefined && "hover:bg-hover",
              selected && "bg-selected",
            )}
          >
            <button
              type="button"
              aria-current={selected ? "true" : undefined}
              disabled={machine.first === undefined}
              onClick={() => machine.first !== undefined && onOpen(machine.first)}
              className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 text-left text-sm text-foreground outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-default"
            >
              <Icon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground", dim)} />
              <span title={machine.name} className={cn("min-w-0 flex-1 truncate", dim)}>
                {machine.name}
              </span>
              <span className={cn("shrink-0 text-2xs text-muted-foreground", STATE_TONE[machine.state])}>{state}</span>
              <span
                data-numeric
                aria-label={`${machine.live} terminals`}
                className={cn("w-4 shrink-0 text-right text-xs text-muted-foreground", dim)}
              >
                {machine.live}
              </span>
            </button>
            <IconButton
              label={`New terminal on ${machine.name}`}
              icon={<Plus />}
              className={cn(
                "mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
                "data-disabled:opacity-0 group-hover:data-disabled:opacity-45 pointer-coarse:data-disabled:opacity-45",
              )}
              disabled={machine.state !== "connected"}
              onClick={() => onNewOn(machine.name)}
            />
          </div>
        );
      })}
      {listError === undefined ? null : (
        <Notice tone="error" className="mx-1 mt-1" title="Could not list the machines">
          {listError}
        </Notice>
      )}
      {failure === undefined ? null : (
        <Notice
          tone="error"
          className="mx-1 mt-1"
          title={`No new terminal on ${failure.machine}`}
          actions={
            <Button variant="ghost" size="sm" onClick={onDismiss}>
              Dismiss
            </Button>
          }
        >
          {failure.message}
        </Notice>
      )}
    </SidebarSection>
  );
}
