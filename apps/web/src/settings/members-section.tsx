import { Notice, SettingRow, cn } from "@doriface/ui";
import { Monitor, Server } from "lucide-react";
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
  const selectedHostId = connectionStore.settings.hostId;
  if (members.length < 2) return null;
  const open = members.filter((entry) => entry.state.phase === "open").length;
  return (
    <div className="flex flex-col gap-3">
      <ul aria-label="Your machines" className="flex flex-col divide-y divide-border">
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
                ) : null
              }
            />
          </li>
        ))}
      </ul>
      {open === members.length ? null : (
        <Notice tone="info" title="One machine down is one machine down">
          Each machine has its own connection, so the others stay usable while one is away.
        </Notice>
      )}
    </div>
  );
}
