import {
  type MeshLineState,
  type MeshMemberStatus,
  type MeshRevokedStatus,
  meshRevokeCommand,
} from "@doriface/protocol";
import { IconButton, SettingRow, cn } from "@doriface/ui";
import { Check, Copy, Monitor, Server } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { formatAge } from "../workspace/model.ts";

export type NameOf = (hostId: string) => string;

const LINE_LABEL: Readonly<Record<MeshLineState, string>> = {
  self: "this host",
  connected: "connected",
  connecting: "connecting",
  unreachable: "unreachable",
  hc_missing: "no herdr there",
  incompatible: "incompatible herdr",
  needs_login: "needs login",
  absent: "not added here",
};
const NEEDS_CARE = new Set<MeshLineState>(["unreachable", "hc_missing", "incompatible", "needs_login"]);

const REVOKE_REASON: Readonly<Record<MeshRevokedStatus["reason"], string>> = {
  revoke: "revoked",
  compromised: "revoked as compromised",
  leave: "left the mesh",
};

type CopyState = "idle" | "copied" | "failed";

/**
 * A command to run elsewhere, with its copy button right beside it. A clipboard that refuses (no permission, no
 * clipboard API) says so in place: the command is selectable, so the owner can copy it by hand.
 */
export function Command({ command, label }: { readonly command: string; readonly label: string }) {
  const [state, setState] = useState<CopyState>("idle");
  useEffect(() => {
    if (state !== "copied") return undefined;
    const timer = setTimeout(() => setState("idle"), 1500);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = (): void => {
    // A browser without the clipboard API throws instead of rejecting, so the call runs inside the promise chain.
    Promise.resolve(command)
      .then((text) => navigator.clipboard.writeText(text))
      .then(
        () => setState("copied"),
        () => setState("failed"),
      );
  };
  return (
    <span className="mt-1 block" data-copy-state={state}>
      <span className="flex items-center gap-1">
        <code className="min-w-0 font-mono text-xs text-foreground select-all">
          {/* Each word is one box, so a line breaks only at a space; a word wider than the line still wraps. */}
          {command.split(" ").map((word, index) => (
            <Fragment key={index}>
              {index === 0 ? null : " "}
              <span className="inline-block max-w-full [overflow-wrap:anywhere]">{word}</span>
            </Fragment>
          ))}
        </code>
        <IconButton label={label} icon={state === "copied" ? <Check /> : <Copy />} onClick={copy} />
      </span>
      {state === "failed" ? (
        <span role="status" className="block text-xs text-status-blocked-text">
          Could not copy: select the command and copy it.
        </span>
      ) : null}
    </span>
  );
}

const Key = ({ fingerprint }: { readonly fingerprint: string }) => (
  <span className="mt-1 block font-mono text-xs tracking-wide text-muted-foreground tabular-nums">{fingerprint}</span>
);

function memberFacts(member: MeshMemberStatus, nameOf: NameOf, now: number): string[] {
  const parts = [member.admittedBy === null ? "founder" : `admitted by ${nameOf(member.admittedBy)}`];
  if (member.overCap) parts.push("over the 12-member cap");
  if (member.unreachableSince === null && member.lastSync !== null) {
    parts.push(`last sync ${formatAge(Date.parse(member.lastSync), now)} ago`);
  }
  if (member.owed > 0) parts.push(`${member.owed} ${member.owed === 1 ? "record" : "records"} to confirm`);
  if (member.gate !== null) {
    parts.push(`next try in ${formatAge(now, Math.max(now, Date.parse(member.gate.nextProbeAt)))}`);
  }
  return parts;
}

export interface MemberRowProps {
  readonly member: MeshMemberStatus;
  readonly nameOf: NameOf;
  readonly now: number;
}

export function MemberRow({ member, nameOf, now }: MemberRowProps) {
  const Icon = member.line === "self" ? Monitor : Server;
  const undecidable = member.line !== "self" && member.witnessPool.length === 0;
  const ask = member.witnessAsk;
  const revoke = member.revokeSuggested ? meshRevokeCommand(member.name) : undefined;
  return (
    <SettingRow
      inline
      title={
        <span className="flex items-center gap-2 [&_svg]:size-4 [&_svg]:text-muted-foreground">
          <Icon aria-hidden />
          {member.name}
        </span>
      }
      description={
        <>
          <span className="block">
            <span className={cn(NEEDS_CARE.has(member.line) && "text-status-blocked-text")}>
              {LINE_LABEL[member.line]}
              {member.unreachableSince === null ? null : ` for ${formatAge(Date.parse(member.unreachableSince), now)}`}
              {member.lineReason === null ? null : `: ${member.lineReason}`}
            </span>
            {memberFacts(member, nameOf, now)
              .map((part) => ` · ${part}`)
              .join("")}
          </span>
          <Key fingerprint={member.fingerprint} />
          {undecidable ? (
            <span className="mt-1 block">
              {`A revoke of ${member.name} written here could not be decided`}
              {ask === null ? "; if its key is compromised, re-found the mesh." : `; revoke it from ${nameOf(ask)}.`}
            </span>
          ) : null}
          {member.replacedMachine === null ? null : (
            <span className="mt-1 block">{`Replaced the machine "${member.replacedMachine}" (doriface-host connect) with the mesh line.`}</span>
          )}
          {revoke === undefined ? null : (
            <Command command={revoke} label={`Copy the command that revokes ${member.name}`} />
          )}
        </>
      }
      control={null}
    />
  );
}

export function RevokedRow({ entry, nameOf }: { readonly entry: MeshRevokedStatus; readonly nameOf: NameOf }) {
  const by = entry.revokedBy.map(nameOf).join(", ");
  return (
    <SettingRow
      inline
      title={entry.name}
      description={
        <>
          <span className="block">
            {by === "" ? REVOKE_REASON[entry.reason] : `${REVOKE_REASON[entry.reason]} by ${by}`}
          </span>
          <Key fingerprint={entry.fingerprint} />
        </>
      }
      control={null}
    />
  );
}
