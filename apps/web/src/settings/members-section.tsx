import { Notice, SettingRow, cn } from "@doriface/ui";
import { Server } from "lucide-react";
import type { ReactNode } from "react";
import type { MemberEntry } from "../connection/mesh-connections.ts";
import { connectionStore, useMeshMembers } from "../connection/store.ts";
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
 * What a member's row offers (#1296): a machine in trouble offers Retry, which is what brings it back; any other offers
 * nothing. Which machine carries this app's traffic is not the person's choice, so no row offers to switch to it (#2531).
 * Decided away from React so the rule the row renders is the rule the tests pin.
 */
export function rowAction(entry: MemberEntry): "retry" | null {
  return PROBLEMS.has(entry.state.phase) ? "retry" : null;
}

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

/** The connection rows, apart from the screen that decides to show them, so a two-machine list can be rendered (#1170). */
export function MemberConnections({ members }: { readonly members: readonly MemberEntry[] }) {
  return (
    // Named so a screen reader can tell this list from the Machines list under it (#1170).
    <ul aria-label="Connections" className="flex flex-col divide-y divide-border">
      {members.map((entry) => {
        const action = rowAction(entry);
        return (
          <li key={entry.target.hostId}>
            <SettingRow
              className="border-b-0"
              inline
              title={title(
                <Server aria-hidden />,
                entry.target.hostName === "" ? entry.target.hostId : entry.target.hostName,
              )}
              description={stateLine(entry)}
              control={
                action === "retry" ? (
                  <RetryButton
                    size="sm"
                    onRetry={async () => {
                      connectionStore.retry(entry.target.hostId);
                    }}
                  />
                ) : null
              }
            />
          </li>
        );
      })}
    </ul>
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
  const summary = summarizeMembers(members);
  if (!summary.listed) return null;
  return (
    <div className="flex flex-col gap-3">
      <MemberConnections members={members} />
      {summary.open === summary.total ? null : (
        <Notice tone="info" title="One machine down is one machine down">
          Each machine has its own connection, so the others stay usable while one is away.
        </Notice>
      )}
    </div>
  );
}
