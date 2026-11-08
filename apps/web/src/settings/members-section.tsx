import { Button, Notice, SettingRow, cn } from "@doriface/ui";
import { Monitor, Server } from "lucide-react";
import type { ReactNode } from "react";
import type { MemberEntry } from "../connection/mesh-connections.ts";
import { connectionStore, useConnectionSettings, useMeshMembers } from "../connection/store.ts";
import { RetryButton } from "../workspace/retry-button.tsx";

const WORDS: Readonly<Record<MemberEntry["state"]["phase"], string>> = {
  open: "Connected",
  connecting: "Connecting",
  unconfigured: "Not set up",
  "host-failed": "Did not start",
  failed: "Offline",
};

const PROBLEMS = new Set(["failed", "host-failed"]);

/**
 * Whether the list is shown, how many rows it has and how many read connected, decided away from React so the rule can
 * be tested: every member this app holds a session to keeps its own row, one member dropping says so in that row instead
 * of taking the list with it, and a single machine is no list at all (#1296, #942 stage 6).
 */
export interface MembersSummary {
  readonly listed: boolean;
  readonly total: number;
  readonly open: number;
}

export function summarizeMembers(entries: readonly MemberEntry[]): MembersSummary {
  return {
    listed: entries.length >= 2,
    total: entries.length,
    open: entries.filter((entry) => entry.state.phase === "open").length,
  };
}

/**
 * Which member a "Switch to this machine" action applies to: every member that is not the one this app is attached to
 * (#1296). Returned as the host id so the rule can be tested without rendering the row, and `undefined` when there is
 * nothing to switch to — one machine, or none.
 */
export function switchTarget(entries: readonly MemberEntry[], activeHostId: string): string | undefined {
  const other = entries.find((entry) => entry.target.hostId !== activeHostId);
  return other?.target.hostId;
}

function title(icon: ReactNode, name: string) {
  return (
    <span className="flex min-w-0 items-center gap-2 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground">
      {icon}
      <span title={name} className="truncate">
        {name}
      </span>
    </span>
  );
}

function stateLine(entry: MemberEntry): ReactNode {
  const { state } = entry;
  const problem = PROBLEMS.has(state.phase);
  return (
    <>
      <span className={cn(problem && "text-status-blocked-text")}>{WORDS[state.phase]}</span>
      {state.phase === "failed" ? <span className="block">{state.error.message}</span> : null}
      {state.phase === "host-failed" ? <span className="block">{state.failure.details}</span> : null}
    </>
  );
}

/**
 * Every machine this app holds its own connection to, each with that connection's own state.
 *
 * The list is the point: a machine that is down is a row saying so, never the whole screen saying it is not connected. It
 * appears only once there is more than one machine to tell apart; with a single machine the sections below already say
 * everything about it.
 */
export function MembersSection() {
  const members = useMeshMembers();
  const selectedHostId = useConnectionSettings().hostId;
  const summary = summarizeMembers(members);
  if (!summary.listed) return null;
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col divide-y divide-border">
        {members.map((entry) => (
          <li key={entry.target.hostId}>
            <SettingRow
              className="border-b-0"
              inline
              title={title(
                entry.target.hostId === selectedHostId ? <Monitor aria-hidden /> : <Server aria-hidden />,
                entry.target.hostName === "" ? entry.target.hostId : entry.target.hostName,
              )}
              description={stateLine(entry)}
              control={
                PROBLEMS.has(entry.state.phase) ? (
                  <RetryButton
                    size="sm"
                    onRetry={async () => {
                      connectionStore.retry(entry.target.hostId);
                    }}
                  />
                ) : entry.target.hostId === selectedHostId ? null : (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      connectionStore.select(entry.target.hostId);
                    }}
                  >
                    Switch to this machine
                  </Button>
                )
              }
            />
          </li>
        ))}
      </ul>
      {summary.open === summary.total ? null : (
        <Notice tone="info" title="One machine down is one machine down">
          Each machine has its own connection, so the others stay usable while one is away.
        </Notice>
      )}
    </div>
  );
}
