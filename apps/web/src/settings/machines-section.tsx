import { MachinesListError } from "../workspace/machines-list-error.tsx";
import type { HcConnection } from "@doriface/client";
import type { MachineView, Terminal } from "@doriface/protocol";
import { Button, Notice, SettingRow, cn } from "@doriface/ui";
import { Monitor, Plus, Server } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useConnection } from "../connection/store.ts";
import { AddMachineDialog } from "../workspace/add-machine-dialog.tsx";
import { machineCause } from "../workspace/machine-cause.ts";
import { RetryButton } from "../workspace/retry-button.tsx";
import { formatAge } from "../workspace/model.ts";
import { useMachines } from "../workspace/use-machines.ts";
import { useNow } from "../workspace/use-now.ts";
import { desktopBridge } from "../desktop/bridge.ts";
import { useConnectionSettings } from "../connection/store.ts";
import { useBrowserMembership } from "../mesh/membership-state.ts";
import { MembershipMachines } from "./membership-device.tsx";
import { machineName } from "../connection/attached-name.ts";

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

export function AddedMachine(props: { view: MachineView; now: number; onRetry: () => Promise<void> }) {
  const { view, now, onRetry } = props;
  const cause = machineCause(view);
  const seen = lastSeen(view, now);
  const word = STATE_WORDS[view.state] ?? "Not connected";
  const problem = PROBLEMS.has(view.state);
  return (
    <li>
      <SettingRow
        className="border-b-0"
        inline
        title={title(<Server aria-hidden />, view.name)}
        description={
          <>
            <span className={cn(problem && "text-status-blocked-text")}>{word}</span>
            {seen === undefined ? null : ` · ${seen}`}
            {cause === undefined ? null : <span className="block">{cause.detail}</span>}
          </>
        }
        control={problem && cause?.retryless !== true ? <RetryButton size="sm" onRetry={onRetry} /> : null}
      />
    </li>
  );
}

function MachineRows({ connection }: { readonly connection: HcConnection }) {
  const settings = useConnectionSettings();
  const ownComputer = desktopBridge() !== null && settings.mode === "loopback";
  const { views, retry, listError, entries } = useMachines(connection, NO_TERMINALS);
  const now = useNow();
  const [adding, setAdding] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <ul aria-label="Machines" className="flex flex-col divide-y divide-border">
        <li>
          <SettingRow
            className="border-b-0"
            title={title(<Monitor aria-hidden />, machineName(connection))}
            description={ownComputer ? "This machine" : "Online · Relay"}
            control={null}
          />
        </li>
        {views.map((view) => (
          <AddedMachine key={view.id} view={view} now={now} onRetry={() => retry(view.name)} />
        ))}
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

/** Every machine this host reaches, this one first: its state, and when it was last seen and why when it is offline. */
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
