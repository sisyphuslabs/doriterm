import type { HcConnection } from "@doriface/client";
import type { MeshStatus } from "@doriface/protocol";
import { Notice, SettingRow, Skeleton, cn } from "@doriface/ui";
import type { ReactNode } from "react";
import { connectionStore, useConnection } from "../connection/store.ts";
import { MeshBanners, PendingRow, RemovedRows } from "../mesh/attention.tsx";
import { disagreement, meshGroups } from "../mesh/groups.ts";
import { MemberRow, RevokedRow } from "../mesh/mesh-rows.tsx";
import { useMesh } from "../mesh/use-mesh.ts";
import { useNow } from "../workspace/use-now.ts";

interface MeshGroupProps {
  readonly id: string;
  readonly title: string;
  readonly count: number;
  /** The owner has to act: the header takes the blocked status ink, as Needs you does in the sidebar. */
  readonly urgent?: boolean;
  readonly children: ReactNode;
}

function MeshGroup({ id, title, count, urgent = false, children }: MeshGroupProps) {
  if (count === 0) return null;
  return (
    <section aria-labelledby={`mesh-${id}`} data-mesh-group={id} className="flex flex-col">
      <h3
        id={`mesh-${id}`}
        className={cn(
          "flex items-baseline gap-2 pb-1 text-base font-semibold",
          urgent ? "text-status-blocked-text" : "text-foreground",
        )}
      >
        {title}
        <span className="text-sm font-normal text-muted-foreground tabular-nums">{count}</span>
      </h3>
      {children}
    </section>
  );
}

function namesIn(status: MeshStatus): (hostId: string) => string {
  const names = new Map<string, string>();
  for (const entry of [...status.members, ...status.revoked, ...status.pending]) names.set(entry.hostId, entry.name);
  for (const removal of status.removed) names.set(removal.revokedKey.hostId, removal.revokedKey.name);
  return (hostId) => names.get(hostId) ?? hostId;
}

function MeshBody({ connection }: { readonly connection: HcConnection }) {
  const { read, answer } = useMesh(connection);
  const now = useNow();
  switch (read.phase) {
    case "loading":
      return <Skeleton className="h-16 rounded-md" />;
    case "failed":
      return (
        <Notice tone="error" title="Could not read the mesh status">
          {read.message}
        </Notice>
      );
    case "unreadable":
      return (
        <Notice tone="warning" title="This mesh status is from another version">
          Update doriface-host or this app. Until then, run doriface-host mesh status on the host.
        </Notice>
      );
    case "none":
      return (
        <SettingRow
          title="Not in a mesh"
          description="Run doriface-host mesh pair on this host, then doriface-host mesh join with its link on the machine to add."
          control={null}
        />
      );
    case "ready":
      break;
  }
  const { status, machines, answered } = read;
  const settings = connectionStore.settings;
  const nameOf = namesIn(status);
  const groups = meshGroups(status);
  const self = nameOf(status.self);
  return (
    <div className="flex flex-col gap-6">
      <MeshBanners
        status={status}
        nameOf={nameOf}
        disagreement={disagreement(status, machines, settings.mode === "relay" ? settings.hostId : undefined)}
      />
      <MeshGroup id="pending" title="Waiting for approval" count={groups.pending.length} urgent>
        {groups.pending.map((join) => (
          <PendingRow
            key={join.nonce}
            join={join}
            self={self}
            now={now}
            answered={answered?.nonce === join.nonce ? answered.verdict : undefined}
            onAnswer={(verdict) => answer(join.nonce, verdict)}
          />
        ))}
      </MeshGroup>
      {groups.removed.map((removal) => (
        <MeshGroup
          key={removal.revokedKey.hostId}
          id={`removed-${removal.revokedKey.hostId}`}
          title="Removed by an undecidable revoke"
          count={removal.members.length}
          urgent
        >
          <RemovedRows removal={removal} />
        </MeshGroup>
      ))}
      <MeshGroup id="online" title="Online" count={groups.online.length}>
        {groups.online.map((member) => (
          <MemberRow key={member.hostId} member={member} nameOf={nameOf} now={now} />
        ))}
      </MeshGroup>
      <MeshGroup id="offline" title="Offline" count={groups.offline.length}>
        {groups.offline.map((member) => (
          <MemberRow key={member.hostId} member={member} nameOf={nameOf} now={now} />
        ))}
      </MeshGroup>
      <MeshGroup id="revoked" title="Revoked" count={groups.revoked.length}>
        {groups.revoked.map((entry) => (
          <RevokedRow key={entry.hostId} entry={entry} nameOf={nameOf} />
        ))}
      </MeshGroup>
    </div>
  );
}

/** Every machine in this host's mesh, grouped by what needs the owner first, from the host's advisory status document. */
export function MeshSection() {
  const state = useConnection();
  if (state.phase !== "open") {
    return <SettingRow title="Not connected" description="Connect to a host to see its mesh." control={null} />;
  }
  return <MeshBody connection={state.connection} />;
}
