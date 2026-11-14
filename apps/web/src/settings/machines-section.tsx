import { MachinesListError } from "../workspace/machines-list-error.tsx";
import type { HcConnection } from "@doriface/client";
import type { MachineView, Terminal } from "@doriface/protocol";
import { Button, Notice, SettingRow, cn } from "@doriface/ui";
import { Monitor, Plus, Server } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useConnection } from "../connection/store.ts";
import { AddMachineDialog } from "../workspace/add-machine-dialog.tsx";
import { machineCause } from "../workspace/machine-cause.ts";
import { RemoveMachineButton, removable } from "../workspace/remove-machine.tsx";
import { RetryButton } from "../workspace/retry-button.tsx";
import { formatAge } from "../workspace/model.ts";
import { useMachineOrder } from "../workspace/use-machine-order.ts";
import { useMachines } from "../workspace/use-machines.ts";
import { useNow } from "../workspace/use-now.ts";
import { desktopBridge } from "../desktop/bridge.ts";
import { useConnectionSettings } from "../connection/store.ts";
import { useBrowserMembership } from "../mesh/membership-state.ts";
import { MembershipMachines } from "./membership-device.tsx";

const NO_TERMINALS: readonly Terminal[] = [];

const STATE_WORDS: Readonly<Record<string, string>> = {
  connected: "Connected",
  reconnecting: "Reconnecting",
  connecting: "Connecting",
  needs_login: "Needs a login",
  unreachable: "Offline",
};

function title(icon: ReactNode, name: string) {
  return (
    <span className="flex min-w-0 items-center gap-2 [&_svg:not([data-slot=spinner])]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground">
      {icon}
      <span title={name} className="truncate">
        {name}
      </span>
    </span>
  );
}

function lastSeen(view: MachineView, now: number): string | undefined {
  if (view.state === "connected" || view.since_ms === undefined || view.since_ms === null) return undefined;
  const age = formatAge(view.since_ms, now);
  return age === "<1m" ? "Last seen just now" : `Last seen ${age} ago`;
}

/** States that need the person: they get the attention hue and Try again; connecting is a routine redial. */
const PROBLEMS = new Set(["unreachable", "needs_login"]);

export interface AddedMachineProps {
  readonly view: MachineView;
  readonly now: number;
  readonly onRetry: () => Promise<void>;
  /** Removes it; offered for a machine added by hand, never a mesh member (#2456). */
  readonly onRemove: (machine: string) => Promise<void>;
}

export function AddedMachine({ view, now, onRetry, onRemove }: AddedMachineProps) {
  const cause = machineCause(view);
  const seen = lastSeen(view, now);
  const word = STATE_WORDS[view.state] ?? "Not connected";
  const problem = PROBLEMS.has(view.state);
  const retry = problem && cause?.retryless !== true;
  const remove = removable(view);
  return (
    <li>
      <SettingRow
        className="border-b-0"
        title={title(<Server aria-hidden />, view.name)}
        description={
          <>
            <span className={cn(problem && "text-status-blocked-text")}>{word}</span>
            {seen === undefined ? null : ` · ${seen}`}
            {cause === undefined ? null : <span className="block">{cause.detail}</span>}
          </>
        }
        control={
          retry || remove ? (
            <span className="flex flex-wrap justify-end gap-2">
              {retry ? <RetryButton size="sm" onRetry={onRetry} /> : null}
              {remove ? <RemoveMachineButton size="sm" name={view.name} onRemove={onRemove} /> : null}
            </span>
          ) : null
        }
      />
    </li>
  );
}

function MachineRows({ connection }: { readonly connection: HcConnection }) {
  const settings = useConnectionSettings();
  const ownComputer = desktopBridge() !== null && settings.mode === "loopback";
  const { views, retry, remove, listError, entries } = useMachines(connection, NO_TERMINALS);
  const arranged = useMachineOrder(connection, entries).entries;
  const now = useNow();
  const [adding, setAdding] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <ul aria-label="Machines" className="flex flex-col divide-y divide-border">
        {arranged.map((entry) => {
          // The machine the page reaches is one row among the others, in the person's order (#2531).
          const view = views.find((each) => each.id === entry.core);
          if (!entry.local && view !== undefined) {
            return <AddedMachine key={entry.id} view={view} now={now} onRetry={() => retry(view.name)} onRemove={remove} />;
          }
          return (
            <li key={entry.id}>
              <SettingRow
                className="border-b-0"
                inline
                title={title(ownComputer ? <Monitor aria-hidden /> : <Server aria-hidden />, entry.name)}
                description={ownComputer ? "This machine" : STATE_WORDS["connected"]}
                control={null}
              />
            </li>
          );
        })}
      </ul>
      {listError === undefined ? null : <MachinesListError cause={listError} />}
      <div>
        <Button onClick={() => setAdding(true)}>
          <Plus aria-hidden />
          Add a machine
        </Button>
      </div>
      <AddMachineDialog open={adding} onClose={() => setAdding(false)} connection={connection} machines={entries} />
    </div>
  );
}

/** Every machine, in the person's order: its state, and when it was last seen and why when it is offline. */
export function MachinesSection() {
  const state = useConnection();
  const mesh = useBrowserMembership();
  if (mesh.phase !== "empty") return <MembershipMachines />;
  if (state.phase !== "open") {
    return (
      <Notice tone="info" title="Not connected">
        Connect to your host to see its machines.
      </Notice>
    );
  }
  return <MachineRows connection={state.connection} />;
}
