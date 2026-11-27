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
import { useMachines } from "../workspace/use-machines.ts";
import { useNow } from "../workspace/use-now.ts";
import { desktopBridge } from "../desktop/bridge.ts";
import { useConnectionSettings } from "../connection/store.ts";
import { useBrowserMembership } from "../mesh/membership-state.ts";
import { MembershipMachines } from "./membership-device.tsx";
import { AgentSkill, type SkillParts } from "./agent-skill-line.tsx";

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
  /** Its agent skill line and Install or Update, while it is connected. */
  readonly skill?: SkillParts;
}

export function AddedMachine({ view, now, onRetry, onRemove, skill }: AddedMachineProps) {
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
            {skill?.line}
          </>
        }
        control={
          retry || remove || skill?.action ? (
            <span className="flex flex-wrap justify-end gap-2">
              {skill?.action}
              {retry ? <RetryButton onRetry={onRetry} /> : null}
              {remove ? <RemoveMachineButton name={view.name} onRemove={onRemove} /> : null}
            </span>
          ) : null
        }
      />
    </li>
  );
}

function MachineRows({ connection, onAdd }: { readonly connection: HcConnection; readonly onAdd: () => void }) {
  const settings = useConnectionSettings();
  const ownComputer = desktopBridge() !== null && settings.mode === "loopback";
  const { views, retry, remove, listError } = useMachines(connection, NO_TERMINALS);
  const now = useNow();
  return (
    <div className="flex flex-col gap-3">
      <ul aria-label="Machines" className="flex flex-col divide-y divide-border">
        <AgentSkill connection={connection} machine={undefined} name={connection.hello.core.name}>
          {(skill) => (
            <li>
              <SettingRow
                className="border-b-0"
                title={title(<Monitor aria-hidden />, connection.hello.core.name)}
                description={
                  <>
                    {ownComputer ? "This machine" : "Online · Relay"}
                    {skill.line}
                  </>
                }
                control={skill.action}
              />
            </li>
          )}
        </AgentSkill>
        {views.map((view) => (
          <AgentSkill
            key={view.id}
            connection={view.state === "connected" ? connection : null}
            machine={view.name}
            name={view.name}
          >
            {(skill) => (
              <AddedMachine view={view} now={now} onRetry={() => retry(view.name)} onRemove={remove} skill={skill} />
            )}
          </AgentSkill>
        ))}
      </ul>
      {listError === undefined ? null : <MachinesListError cause={listError} />}
      <div>
        <Button onClick={onAdd}>
          <Plus aria-hidden />
          Add a machine
        </Button>
      </div>
    </div>
  );
}

function MachineJoinDialog({
  connection,
  onClose,
}: {
  readonly connection: HcConnection;
  readonly onClose: () => void;
}) {
  const { entries } = useMachines(connection, NO_TERMINALS);
  return <AddMachineDialog open onClose={onClose} connection={connection} machines={entries} />;
}

/** Every machine this host reaches, this one first: its state, and when it was last seen and why when it is offline. */
export function MachinesSection() {
  const state = useConnection();
  const mesh = useBrowserMembership();
  const [inviter, setInviter] = useState<HcConnection | null>(null);
  const connection = state.phase === "open" ? state.connection : null;
  const offerConnection = connection?.hello.core.id === inviter?.hello.core.id ? connection : inviter;
  return (
    <>
      {mesh.phase !== "empty" ? (
        <MembershipMachines />
      ) : connection === null ? (
        <Notice tone="info" title="Not connected">
          Connect to your host to see its machines.
        </Notice>
      ) : (
        <MachineRows connection={connection} onAdd={() => setInviter(connection)} />
      )}
      {/* Accepting the invite can replace the machine list before the dialog reads the join receipt. */}
      {offerConnection !== null && mesh.phase !== "removed" ? (
        <MachineJoinDialog connection={offerConnection} onClose={() => setInviter(null)} />
      ) : null}
    </>
  );
}
