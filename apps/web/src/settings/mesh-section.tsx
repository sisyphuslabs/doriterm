import type { HcConnection } from "@doriface/client";
import type { MeshStatus } from "@doriface/protocol";
import { Notice, SettingRow, Skeleton, cn, groupHeadingClass } from "@doriface/ui";
import { type ReactNode, useSyncExternalStore } from "react";
import type { ConnectionSettings } from "../connection/settings.ts";
import { connectionStore, useConnection } from "../connection/store.ts";
import { ExpiredJoinRow, MeshBanners, PendingRow, RemovedRows } from "../mesh/attention.tsx";
import { disagreement, meshGroups } from "../mesh/groups.ts";
import { MemberRow } from "../mesh/mesh-rows.tsx";
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
        className={cn("flex items-baseline gap-2 pb-1", groupHeadingClass, urgent && "text-status-blocked-text")}
      >
        {title}
        <span className="font-normal text-muted-foreground tabular-nums">{count}</span>
      </h3>
      {children}
    </section>
  );
}

function namesIn(status: MeshStatus): (hostId: string) => string {
  const names = new Map<string, string>();
  for (const entry of [...status.members, ...status.revoked, ...status.pending]) {
    names.set(entry.hostId, entry.name ?? entry.hostId);
  }
  for (const removal of status.removed) names.set(removal.revokedKey.hostId, removal.revokedKey.name);
  return (hostId) => names.get(hostId) ?? hostId;
}

/** The part of the connection store the Mesh banners read: the settings, and the change they follow. */
export interface PairedHostStore {
  readonly settings: ConnectionSettings;
  subscribe(listener: () => void): () => void;
}

/**
 * The host this device is paired with over the relay, or undefined in loopback mode: the status document is checked
 * against it. Subscribed, so a change of mode or of the shown machine while Settings > Mesh is open reaches the
 * disagreement banner (#1132, #2023).
 */
export function usePairedHost(store: PairedHostStore = connectionStore): string | undefined {
  const settings = useSyncExternalStore(store.subscribe, () => store.settings);
  return settings.mode === "relay" ? settings.hostId : undefined;
}

export function MeshBody({
  connection,
  attentionOnly,
}: {
  readonly connection: HcConnection;
  readonly attentionOnly: boolean;
}) {
  // Above the early returns, so the hooks run in the same order whatever the mesh read's phase.
  const pairedHost = usePairedHost();
  const { read, answer } = useMesh(connection);
  const now = useNow();
  const host = connection.hello.core.name;
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
          title="No machine in this mesh yet"
          description={`${host} is in no mesh, so no other machine is reachable from it yet. On ${host}, run doriface-host mesh pair to open an invite, then doriface-host mesh join with that link on the machine to connect.`}
          control={null}
        />
      );
    case "ready":
      break;
  }
  const { status, machines, answered } = read;
  const nameOf = namesIn(status);
  const groups = meshGroups(status, now);
  const self = nameOf(status.self);
  return (
    <div className="flex flex-col gap-6">
      <MeshBanners status={status} nameOf={nameOf} disagreement={disagreement(status, machines, pairedHost)} />
      {!attentionOnly ? (
        <p className="max-w-measure text-prose text-muted-foreground">
          {`${self} reaches the other machines through its own relay only, and nowhere without one; it opens no direct link to them. A machine row says whether a session to it is open now.`}
        </p>
      ) : null}
      <MeshGroup id="pending" title="Waiting for approval" count={groups.pending.length} urgent>
        {groups.pending.map((join) => (
          <PendingRow
            key={join.nonce}
            join={join}
            self={self}
            now={now}
            answered={answered?.nonce === join.nonce ? answered.verdict : undefined}
            onAnswer={(verdict) => answer(join.nonce, verdict, join.code)}
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
      {!attentionOnly ? (
        <>
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
          {groups.revokedCount === 0 ? null : (
            <p data-mesh-revoked className="text-prose text-muted-foreground tabular-nums">
              {groups.revokedCount} removed {groups.revokedCount === 1 ? "machine" : "machines"}: doriface-host mesh
              status lists {groups.revokedCount === 1 ? "it" : "them"}.
            </p>
          )}
        </>
      ) : null}
      <MeshGroup id="expired" title="Expired join requests" count={groups.expired.length}>
        {groups.expired.map((join) => (
          <ExpiredJoinRow key={join.nonce} join={join} self={self} now={now} />
        ))}
      </MeshGroup>
    </div>
  );
}

/** Every machine in this host's mesh, with the joins that need the owner, from the host's advisory status document. */
export function MeshSection({ attentionOnly = false }: { readonly attentionOnly?: boolean }) {
  const state = useConnection();
  if (state.phase !== "open") {
    if (attentionOnly) return null;
    return (
      <SettingRow
        title="Not connected"
        description="This app is not connected to a host yet, so there is no mesh to show. Set the connection up under This device."
        control={null}
      />
    );
  }
  return <MeshBody connection={state.connection} attentionOnly={attentionOnly} />;
}
