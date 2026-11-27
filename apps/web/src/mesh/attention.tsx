import type { MeshPendingJoin, MeshRemovedStatus, MeshStatus, MeshStuckReason } from "@doriface/protocol";
import { Button, Fingerprint, Notice, SettingRow, cn } from "@doriface/ui";
import { rowValueClass } from "../settings/settings-layout.tsx";
import { formatAge } from "../workspace/model.ts";
import { type Disagreement, type PendingAnswer, approvalConsequence, pendingAnswer } from "./groups.ts";
import { Command, type NameOf } from "./mesh-rows.tsx";
import type { Answered } from "./mesh-reader.ts";
import type { Verdict } from "./use-mesh.ts";
import { useJoinAnswer } from "./use-join-answer.ts";

/** What an owner runs on an affected machine to found a fresh mesh after a fail-closed removal (design section 3.7). */
export const REFOUND_COMMAND = "doriface-host mesh leave && doriface-host mesh pair";

export interface ExpiredJoinRowProps {
  readonly join: MeshPendingJoin;
  readonly holder: string;
  readonly now: number;
}

/** A join whose offer ended: it takes no answer, so the row has none to give. */
export function ExpiredJoinRow({ join, holder, now }: ExpiredJoinRowProps) {
  return (
    <SettingRow
      title={`${join.name} asked to join`}
      description={`through ${holder}; its offer ended ${formatAge(Date.parse(join.expiresAt), now)} ago`}
      control={
        <span data-row-value className={rowValueClass} data-mesh-answer="expired">
          Expired
        </span>
      }
    />
  );
}

export interface PendingRowProps {
  readonly join: MeshPendingJoin;
  /** The machine that holds the join, whose approval document answers it. */
  readonly holder: string;
  readonly now: number;
  /** The holder's answer document, when it names this join. */
  readonly answered: Answered | undefined;
  readonly onAnswer: (verdict: Verdict) => Promise<void>;
}

/** What a join that takes no answer says: the host's word on the last one, never more than the host said (#2936). */
export function settledText(state: Exclude<PendingAnswer, "open" | "expired">, name: string, holder: string): string {
  switch (state) {
    case "sending":
      return `Sending the answer to ${holder}`;
    case "approve":
      return `Waiting for ${name} to confirm the code`;
    case "deny":
      return "Denied: the codes differed. Open a new invite.";
    case "gone":
      return `${holder} no longer holds this join: it expired or was answered elsewhere. Open a new invite.`;
  }
}

/** The holder's reason for refusing the last answer to this join, when it refused one. */
export const refusalText = (
  join: MeshPendingJoin,
  holder: string,
  answered: Answered | undefined,
): string | undefined =>
  answered?.nonce === join.nonce && answered.outcome.kind === "refused"
    ? `${holder} refused that answer: ${answered.outcome.reason}`
    : undefined;

export function PendingRow({ join, holder, now, answered, onAnswer }: PendingRowProps) {
  const { busy, failure, send } = useJoinAnswer(onAnswer);
  const left = Date.parse(join.expiresAt) - now;
  const state = pendingAnswer(join, now, answered);
  const shownFailure = failure ?? refusalText(join, holder, answered);
  const consequence = approvalConsequence(join.kind, join.name);
  // The offer can end while the row is up, before the groups move it.
  if (state === "expired") return <ExpiredJoinRow join={join} holder={holder} now={now} />;
  return (
    <SettingRow
      title={`Approve "${join.name}" (${join.kind === "client" ? "browser" : "machine"})?`}
      description={
        <>
          <span className="block">{`through ${holder}, offer open for ${formatAge(0, left)} more`}</span>
          {join.code === undefined ? (
            <span className="block">Update the inviting machine to compare a join code.</span>
          ) : (
            <>
              <span aria-label="Join code" className="my-3 block font-mono text-2xl tracking-widest tabular-nums">
                {join.code}
              </span>
              <span className="block">
                Approve only if the joining screen shows the same code. Look at it, or ask by a call or in person, not
                in the chat that carried the link.
              </span>
            </>
          )}
          <details className="mt-2">
            <summary>Details</summary>
            <Fingerprint label={`${join.name}'s key`} value={join.fingerprint.replaceAll(" ", "")} />
          </details>
          {shownFailure === undefined ? null : (
            <span className="mt-1 block text-status-blocked-text">{shownFailure}</span>
          )}
          {consequence === undefined ? null : <span className="mt-1 block">{consequence}</span>}
        </>
      }
      control={
        state === "open" ? (
          <div className="flex gap-2" data-mesh-answer={state}>
            <Button
              data-mesh-verdict="deny"
              loading={busy === "deny"}
              disabled={busy !== undefined}
              onClick={() => send("deny")}
            >
              The codes differ
            </Button>
            <Button
              variant="primary"
              data-mesh-verdict="approve"
              loading={busy === "approve"}
              disabled={busy !== undefined || join.code === undefined}
              onClick={() => send("approve")}
            >
              Approve
            </Button>
          </div>
        ) : (
          // As tall as the buttons it replaces, so the rows below stay where they were.
          <span
            data-row-value
            className={cn("inline-flex min-h-(--control) items-center", rowValueClass)}
            data-mesh-answer={state}
          >
            {settledText(state, join.name, holder)}
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
    case "unknown":
      return "The host gives a reason this app does not know yet. Update the app to see it.";
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
        <div data-mesh-banner="disagreement">
          <Notice tone="warning" title="The status document disagrees with machine.list">
            {disagreement.otherHost ? "It was written for another host. " : ""}
            {disagreement.names.length === 0 ? "" : `machine.list shows ${disagreement.names.join(", ")} differently. `}
            Anyone connected to this host can rewrite the document, so trust what the machines list shows.
          </Notice>
        </div>
      )}
      {status.stuck.length === 0 ? null : (
        <div data-mesh-banner="stuck">
          <Notice tone="error" title="Mesh sync is stuck">
            {status.stuck.map((reason) => (
              <span key={`${reason.kind}-${"member" in reason ? reason.member : ""}`} className="block">
                {stuckText(reason, nameOf)}
              </span>
            ))}
          </Notice>
        </div>
      )}
      {status.budget.halvedUntil === null ? null : (
        <div data-mesh-banner="rate-limit">
          <Notice tone="warning" title="The relay is limiting this address">
            Other hosts behind the same address share its limit, so new lines open more slowly for now.
          </Notice>
        </div>
      )}
      {status.notices.map((notice) => (
        <div key={notice.hostId} data-mesh-banner="notice" data-mesh-notice={notice.hostId}>
          <Notice tone="info" title={`${notice.name} joined the mesh`}>
            {`Admitted by ${nameOf(notice.admittedBy)} on ${dayOf(notice.seenAt)}. Its key is `}
            <span className="font-mono tabular-nums">{notice.fingerprint}</span>.
          </Notice>
        </div>
      ))}
    </>
  );
}
