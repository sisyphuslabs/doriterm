import { type PushClientLine, type PushHostLine, parsePushNotice, type PushNotice } from "@doriface/protocol";
import { parseOptionAction } from "./notice-display.ts";

/** What a tapped action asks the page to send once it is visible: Allow, or one of the prompt's own rows. */
export type PageAnswer = { readonly kind: "allow" } | { readonly kind: "option"; readonly option: string };

/** The app's address for a notice: it asks the host over the push stream which pane that is and opens it. */
export const noticeUrl = (notice: PushNotice, answer?: PageAnswer): string =>
  `/?notice=${encodeURIComponent(notice.n)}&host=${notice.h}${
    answer === undefined ? "" : `&answer=${answer.kind === "allow" ? "allow" : `option:${answer.option}`}`
  }`;

export type ClickPlan = { readonly open: string } | { readonly open: null; readonly answered: string };

/**
 * What a tap on a notification does. A tap on the notice opens its pane. An answer that is not a decline (Allow, or a
 * row other than the agent's No) never types from the notification, which a locked device may show: it opens the pane,
 * and the page sends the answer once it is visible. Deny, or the agent's No row, asks the host to answer at once; the
 * host sends the agent's key only if the prompt is still the one on the live screen, and if it was answered or changed,
 * or the host cannot be reached, nothing is sent and the pane opens instead.
 */
export async function planClick(
  action: string,
  data: unknown,
  send: (line: PushClientLine) => Promise<PushHostLine>,
): Promise<ClickPlan> {
  const notice = parsePushNotice(data);
  if (notice === undefined) return { open: "/" };
  const row = parseOptionAction(action);
  const asks = notice.k === "permission" || (notice.k === "input" && row !== undefined);
  if (!asks) return { open: noticeUrl(notice) };
  if (action === "allow") return { open: noticeUrl(notice, { kind: "allow" }) };
  if (row !== undefined && !row.declines) return { open: noticeUrl(notice, { kind: "option", option: row.option }) };
  const line: PushClientLine | undefined =
    action === "deny"
      ? { t: "answer", id: notice.n, answer: "deny" }
      : row === undefined
        ? undefined
        : { t: "choose", id: notice.n, option: row.option };
  if (line === undefined) return { open: noticeUrl(notice) };
  try {
    const reply = await send(line);
    if (reply.t === "answered") return { open: null, answered: reply.terminal };
  } catch {
    // The host could not be reached: nothing was sent, so the pane opens and the person answers there.
  }
  return { open: noticeUrl(notice) };
}
