import {
  type MeshLineState,
  type MeshMemberStatus,
  type MeshRevokedStatus,
  meshRevokeCommand,
} from "@doriface/protocol";
import { IconButton, SettingRow, cn } from "@doriface/ui";
import { Check, Copy, Monitor, Server } from "lucide-react";
import { useState } from "react";
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

export function CopyCommand({ command, label }: { readonly command: string; readonly label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return <IconButton label={label} icon={copied ? <Check /> : <Copy />} onClick={() => void copy()} />;
}

/** A command to run elsewhere, with its copy button right beside it. */
export const Command = ({ command, label }: { readonly command: string; readonly label: string }) => (
  <span className="mt-1 flex items-center gap-1">
    <code className="min-w-0 font-mono text-xs break-all text-foreground select-all">{command}</code>
    <CopyCommand command={command} label={label} />
  </span>
);

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
