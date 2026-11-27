import { type MeshMemberStatus, meshRevokeCommand, replacedMachineText } from "@doriface/protocol";
import { IconButton, SettingRow, cn } from "@doriface/ui";
import { Check, Copy, Monitor, Server, Smartphone } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { formatAge } from "../workspace/model.ts";
import { REACH_LABEL, reachOf } from "./reach.ts";

export type NameOf = (hostId: string) => string;

const LINE_LABEL: Readonly<Record<MeshMemberStatus["line"], string>> = {
  self: "this host",
  connected: "connected",
  connecting: "connecting",
  unreachable: "unreachable",
  hc_missing: "no herdr there",
  incompatible: "incompatible herdr",
  needs_login: "needs login",
  absent: "not added here",
  unknown: "a state this app does not know",
};
const NEEDS_CARE = new Set<MeshMemberStatus["line"]>(["unreachable", "hc_missing", "incompatible", "needs_login"]);

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
      {/* The live region stays mounted and is filled on failure, so screen readers announce the message. */}
      <span role="status" className="block text-status-blocked-text">
        {state === "failed" ? "Could not copy: select the command and copy it." : null}
      </span>
    </span>
  );
}

const Key = ({ fingerprint, hostId }: { readonly fingerprint: string | null; readonly hostId: string }) => (
  <span className="mt-1 flex flex-wrap items-baseline gap-x-3 font-mono text-xs tracking-wide text-muted-foreground tabular-nums">
    {fingerprint === null ? null : <span>{fingerprint}</span>}
    <span>{`id ${hostId}`}</span>
  </span>
);

function memberFacts(member: MeshMemberStatus, nameOf: NameOf, now: number): string[] {
  const parts: string[] = [];
  if (member.admittedBy !== null) parts.push(`admitted by ${nameOf(member.admittedBy)}`);
  else if (!member.overCap) parts.push("founder");
  if (member.overCap) parts.push("over an older host's member cap");
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

/**
 * Where a revoke of this member could be decided, kept behind a disclosure: it matters only when a key is lost, and in
 * a small mesh it is true of every new member, so in the open it reads as an alarm on each device that just joined.
 */
function RevokeCaveat({ name, ask }: { readonly name: string; readonly ask: string | null }) {
  return (
    <details className="mt-1">
      <summary>If its key is lost</summary>
      {`A revoke of ${name} written here could not be decided`}
      {ask === null ? "; re-found the mesh." : `; revoke it from ${ask}.`}
    </details>
  );
}

/** A browser or phone in the mesh: never dialed, so it has no line; it says when it last opened a session here. */
export function ClientRow({ member, nameOf, now }: MemberRowProps) {
  const name = member.name ?? member.hostId;
  const facts = [
    member.admittedBy === null ? "joined" : `joined · admitted by ${nameOf(member.admittedBy)}`,
    member.lastSessionAt === undefined
      ? "no session here yet"
      : `last session here ${formatAge(member.lastSessionAt, now)} ago`,
  ];
  return (
    <SettingRow
      inline
      title={
        <span className="flex items-center gap-2 [&_svg]:size-4 [&_svg]:text-muted-foreground">
          <Smartphone aria-hidden />
          {name}
        </span>
      }
      description={
        <>
          <span className="block">{facts.join(" · ")}</span>
          <Key fingerprint={member.fingerprint} hostId={member.hostId} />
          {member.witnessPool.length === 0 ? (
            <RevokeCaveat name={name} ask={member.witnessAsk === null ? null : nameOf(member.witnessAsk)} />
          ) : null}
        </>
      }
      control={null}
    />
  );
}

export function MemberRow({ member, nameOf, now }: MemberRowProps) {
  const Icon = member.line === "self" ? Monitor : Server;
  const undecidable = member.line !== "self" && member.witnessPool.length === 0;
  const ask = member.witnessAsk;
  const name = member.name ?? member.hostId;
  const revoke = member.revokeSuggested && member.name !== null ? meshRevokeCommand(member.name) : undefined;
  return (
    <SettingRow
      inline
      title={
        <span className="flex items-center gap-2 [&_svg:not([data-slot=spinner])]:size-4 [&_svg]:text-muted-foreground">
          <Icon aria-hidden />
          {name}
        </span>
      }
      description={
        <>
          <span className="block">
            <span className={cn(NEEDS_CARE.has(member.line) && "text-status-blocked-text")}>
              {LINE_LABEL[member.line]}
              {member.unreachableSince === null ? null : ` for ${formatAge(Date.parse(member.unreachableSince), now)}`}
              {member.lineReason === null ? null : `: ${member.lineReason}`}
              {member.line === "self" ? null : ` · ${REACH_LABEL[reachOf(member)]}`}
            </span>
            {memberFacts(member, nameOf, now)
              .map((part) => ` · ${part}`)
              .join("")}
          </span>
          <Key fingerprint={member.fingerprint} hostId={member.hostId} />
          {undecidable ? <RevokeCaveat name={name} ask={ask === null ? null : nameOf(ask)} /> : null}
          {member.replacedMachine === null ? null : (
            <span className="mt-1 block">{`R${replacedMachineText(member.replacedMachine).slice(1)}.`}</span>
          )}
          {revoke === undefined ? null : <Command command={revoke} label={`Copy the command that revokes ${name}`} />}
        </>
      }
      control={null}
    />
  );
}
