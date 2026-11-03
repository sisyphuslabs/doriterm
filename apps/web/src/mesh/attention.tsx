import type { MeshPendingJoin, MeshRemovedStatus, MeshStatus, MeshStuckReason } from "@doriface/protocol";
import { Button, Fingerprint, Notice, SettingRow } from "@doriface/ui";
import { useState } from "react";
import { formatAge } from "../workspace/model.ts";
import type { Disagreement } from "./groups.ts";
import { Command, type NameOf } from "./mesh-rows.tsx";
import type { Verdict } from "./use-mesh.ts";

/** What an owner runs on an affected machine to found a fresh mesh after a fail-closed removal (design section 3.7). */
export const REFOUND_COMMAND = "doriface-host mesh leave && doriface-host mesh pair";

export interface PendingRowProps {
  readonly join: MeshPendingJoin;
  readonly self: string;
  readonly now: number;
  readonly answered: Verdict | undefined;
  readonly onAnswer: (verdict: Verdict) => Promise<void>;
}

export function PendingRow({ join, self, now, answered, onAnswer }: PendingRowProps) {
  const [busy, setBusy] = useState<Verdict | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const send = (verdict: Verdict): void => {
    setBusy(verdict);
    setFailure(undefined);
    onAnswer(verdict).then(
      () => setBusy(undefined),
      (error: unknown) => {
        setBusy(undefined);
        setFailure(error instanceof Error ? error.message : String(error));
      },
    );
  };
  const left = Date.parse(join.expiresAt) - now;
  return (
    <SettingRow
      title={`${join.name} asks to join`}
      description={
        <>
          <span className="block">
            {left > 0 ? `through ${self}, offer open for ${formatAge(0, left)} more` : "the offer has expired"}
          </span>
          <Fingerprint
            className="mt-2"
            label={`${join.name}'s key: compare it with what mesh join shows there`}
            value={join.fingerprint.replaceAll(" ", "")}
          />
          {failure === undefined ? null : <span className="mt-1 block text-status-blocked-text">{failure}</span>}
        </>
      }
      control={
        answered === undefined ? (
          <div className="flex gap-2">
            <Button size="sm" loading={busy === "deny"} disabled={busy !== undefined} onClick={() => send("deny")}>
              Deny
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={busy === "approve"}
              disabled={busy !== undefined}
              onClick={() => send("approve")}
            >
              Approve
            </Button>
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">
            {answered === "approve" ? `Approved; ${self} admits it next` : "Denied"}
          </span>
        )
      }
    />
  );
}

export function RemovedRows({ removal }: { readonly removal: MeshRemovedStatus }) {
  const who = removal.members.map((entry) => entry.name).join(", ");
  return (
    <>
      {removal.members.map((entry) => (
        <SettingRow
          key={entry.hostId}
          inline
          title={entry.name}
          description={`removed by a backdated revoke from ${removal.revokedKey.name}'s key that this mesh cannot decide`}
          control={null}
        />
      ))}
      <SettingRow
        title="Re-found the mesh"
        description={
          <>
            <span className="block text-pretty">
              {`The mesh failed closed: no key of ${removal.revokedKey.name}'s gets in, and ${who} cannot rejoin this mesh. ` +
                `On ${who}, leave and found a new mesh, or rotate its keys.`}
            </span>
            <Command command={REFOUND_COMMAND} label="Copy the re-found command" />
          </>
        }
        control={null}
      />
    </>
  );
}

const dayOf = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function stuckText(reason: MeshStuckReason, nameOf: NameOf): string {
  switch (reason.kind) {
    case "name_taken":
      return `"${reason.name}" and its fallback names are taken on this host's core (${nameOf(reason.member)}).`;
    case "invalid_name":
      return `herdr refused the name "${reason.name}": ${reason.message}`;
    case "copied_core":
      return `Another machine here answers with ${nameOf(reason.member)}'s core.`;
    case "line_idle":
      return `The line to ${nameOf(reason.member)} has been up for 60 s without connecting.`;
    case "possibly_revoked":
      return "This host may have been revoked.";
    case "read_only":
      return `This host was revoked${reason.by.length === 0 ? "" : ` by ${reason.by.map(nameOf).join(", ")}`} and only reads the mesh until ${dayOf(reason.until)}.`;
    case "removed_undecidable":
      return "This host was removed by a revoke this mesh cannot decide.";
    case "log_full":
      return `The mesh log is full (${reason.records} records).`;
    case "counter_behind":
      return `Its record counter is behind (file ${reason.file}, mesh ${reason.mesh}); it syncs before it signs.`;
  }
}

export interface BannersProps {
  readonly status: MeshStatus;
  readonly disagreement: Disagreement | undefined;
  readonly nameOf: NameOf;
}

/** The status document is advisory: a disagreement with what this device sees comes first, then problems, then news. */
export function MeshBanners({ status, disagreement, nameOf }: BannersProps) {
  return (
    <>
      {disagreement === undefined ? null : (
        <Notice tone="warning" title="The status document disagrees with machine.list">
          {disagreement.otherHost ? "It was written for another host. " : ""}
          {disagreement.names.length === 0 ? "" : `machine.list shows ${disagreement.names.join(", ")} differently. `}
          Anyone connected to this host can rewrite the document, so trust what the machines list shows.
        </Notice>
      )}
      {status.stuck.length === 0 ? null : (
        <Notice tone="error" title="Mesh sync is stuck">
          {status.stuck.map((reason) => (
            <span key={`${reason.kind}-${"member" in reason ? reason.member : ""}`} className="block">
              {stuckText(reason, nameOf)}
            </span>
          ))}
        </Notice>
      )}
      {status.budget.halvedUntil === null ? null : (
        <Notice tone="warning" title="The relay is limiting this address">
          Other hosts behind the same address share its limit, so new lines open more slowly for now.
        </Notice>
      )}
      {status.notices.map((notice) => (
        <Notice key={notice.hostId} tone="info" title={`${notice.name} joined the mesh`}>
          {`Admitted by ${nameOf(notice.admittedBy)} on ${dayOf(notice.seenAt)}. Its key is `}
          <span className="font-mono tabular-nums">{notice.fingerprint}</span>.
        </Notice>
      ))}
    </>
  );
}
