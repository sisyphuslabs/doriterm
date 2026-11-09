import type { HcConnection } from "@doriface/client";
import { markApproval, type NoticeContext, noticeContextOf } from "@doriface/protocol";
import { approvalCore } from "../approval/approval-core.ts";
import type { Trigger } from "./notice-trigger.ts";
import { deadlineAfter } from "./over-push.ts";

/** How long a desktop notice waits for the terminal's record and screen before it shows with the event's status alone. */
export const LOOK_MS = 2_000;

export type NoticeLook = (connection: HcConnection, hit: Trigger) => Promise<NoticeContext>;

/**
 * What a notice is about, read off the core as the host reads it for a push (apps/host push-service `#look`): the
 * terminal's record and, for a permission or a question, its prompt on the live screen. A core that does not answer
 * in time, or cannot, leaves the event's own status: the notice still shows, naming what it can.
 */
export async function lookUpNotice(connection: HcConnection, hit: Trigger): Promise<NoticeContext> {
  const core = approvalCore(connection);
  const asks = hit.kind === "permission" || hit.kind === "input";
  const deadline = deadlineAfter(LOOK_MS);
  try {
    const [terminal, screen] = await Promise.race([
      Promise.all([core.terminal(hit.terminal), asks ? core.screen(hit.terminal) : undefined]),
      deadline.expired,
    ]);
    const prompt = screen === undefined ? undefined : markApproval(terminal, screen)?.prompt;
    return noticeContextOf({ terminal, status: hit.status, machine: hit.machine, prompt });
  } catch {
    return noticeContextOf({ status: hit.status, machine: hit.machine });
  } finally {
    deadline.cancel();
  }
}
