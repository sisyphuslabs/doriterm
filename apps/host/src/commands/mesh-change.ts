import { requestControl } from "../control.ts";
import { PUSH_WITHIN_MS } from "../mesh/commands.ts";
import {
  type MemberRef,
  parseLeavePreview,
  parseLeaveReply,
  parseRenameReply,
  parseRevokeReply,
} from "../mesh/command-replies.ts";
import { printable } from "./devices.ts";

// `mesh revoke`, `mesh rename` and `mesh leave`: each asks the running host on the state dir, which signs (design
// 6.1, 6.5 and 7.5), and prints its answer. Each returns the exit code.

export interface ChangeContext {
  readonly stateDir: string;
  readonly out: (text: string) => void;
  /** Asks the owner on a terminal; false when there is none. */
  readonly confirm: (question: string) => Promise<boolean>;
}

async function ask(context: ChangeContext, request: Parameters<typeof requestControl>[1]): Promise<unknown> {
  const reply = await requestControl(context.stateDir, request);
  if (reply === undefined) throw new Error(`no doriface-host is running on ${context.stateDir}`);
  if (reply === null) context.out("this host is in no mesh\n");
  return reply;
}

const line = (context: ChangeContext, text: string): void => context.out(`${printable(text)}\n`);

const refs = (members: readonly MemberRef[]): string =>
  members.map((member) => `${member.name} (${member.hostId})`).join(", ");

export async function revokeMember(
  context: ChangeContext,
  member: string,
  compromised: boolean,
  yes: boolean,
): Promise<number> {
  const request = { op: "mesh-revoke", member, compromised } as const;
  const shown = await ask(context, { ...request, yes, preview: true, expect: undefined });
  if (shown === null) return 1;
  const preview = parseRevokeReply(shown);
  line(context, `revoke ${refs(preview.subjects)} (${preview.reason})`);
  if (preview.clients.length > 0) {
    line(context, `these browsers and phones leave the mesh with ${preview.target.name}: ${refs(preview.clients)}`);
  }
  for (const text of preview.lines) line(context, text);
  if (preview.needsYes && !yes && !(await context.confirm("write this revoke? [y/N] "))) {
    line(context, "not written: run it again with --yes to write this revoke");
    return 1;
  }
  const expect = [...preview.subjects, ...preview.clients].map((subject) => subject.hostId);
  const answer = await ask(context, { ...request, yes: true, preview: false, expect });
  if (answer === null) return 1;
  const reply = parseRevokeReply(answer);
  if (!reply.written) {
    line(context, "not written: the running host did not write the previewed revoke");
    return 1;
  }
  line(context, `revoked ${refs(reply.subjects)} (${reply.reason})`);
  return 0;
}

export async function renameMember(context: ChangeContext, member: string, name: string): Promise<number> {
  const answer = await ask(context, { op: "mesh-rename", member, name });
  if (answer === null) return 1;
  const reply = parseRenameReply(answer);
  line(
    context,
    reply.written
      ? `renamed ${refs([reply.member])} to ${reply.name}`
      : `${refs([reply.member])} is already named ${reply.name}`,
  );
  return 0;
}

export async function leaveMesh(context: ChangeContext, yes = false): Promise<number> {
  const shown = await ask(context, { op: "mesh-leave", preview: true });
  if (shown === null) return 1;
  const preview = parseLeavePreview(shown);
  if (preview.clients.length > 0) {
    line(context, `these browsers and phones leave the mesh with this machine: ${refs(preview.clients)}`);
    if (!yes && !(await context.confirm("leave this mesh? [y/N] "))) {
      line(context, "not left");
      return 1;
    }
  }
  const answer = await ask(context, {
    op: "mesh-leave",
    preview: false,
    expect: preview.clients.map((client) => client.hostId),
  });
  if (answer === null) return 1;
  const reply = parseLeaveReply(answer);
  const names = (members: typeof reply.members) => members.map((ref) => ref.name).join(", ");
  if (!reply.signed) line(context, "this host was no member in its own view, so it had no revoke to sign");
  if (reply.members.length === 0) line(context, "left the mesh; no other member was in it");
  else if (reply.confirmed.length > 0) {
    line(
      context,
      `left the mesh: ${reply.confirmed.length} of ${reply.members.length} members confirmed (${names(reply.confirmed)})`,
    );
  } else {
    line(context, `left the mesh, but reached no member within ${PUSH_WITHIN_MS / 1000} s (${names(reply.members)})`);
    if (reply.revokeCommand !== null) line(context, `run this on one of them: ${reply.revokeCommand}`);
  }
  if (reply.machinesKept === null) return 0;
  line(context, `but this host's mesh machines were not all removed from herdr: ${reply.machinesKept}`);
  line(context, "remove them with: hc machine list, then hc machine rm <name>");
  return 1;
}

export async function confirmOnTerminal(question: string): Promise<boolean> {
  if (process.stdin.isTTY !== true) return false;
  process.stdout.write(question);
  for await (const answer of console) return /^y(es)?$/i.test(answer.trim());
  return false;
}
