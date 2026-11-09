import { type NoticePrompt, noticeText, type PushHostLine, type PushNotice } from "@doriface/protocol";

const TEST_BODY = "Notifications from this host work.";

/** The two answers a permission notice offers where the platform shows notification actions and the host names no rows. */
export const ANSWER_ACTIONS = [
  { action: "allow", title: "Allow" },
  { action: "deny", title: "Deny" },
] as const;

/** How many actions a notification shows when the platform does not say: Chromium's own limit. */
export const DEFAULT_MAX_ACTIONS = 2;

/** A row's action name: `option:<id>`, with `:declines` for the agent's No row, which may answer without the app. */
export const optionAction = (id: string, declines: boolean): string => `option:${id}${declines ? ":declines" : ""}`;

export function parseOptionAction(action: string): { readonly option: string; readonly declines: boolean } | undefined {
  const match = /^option:(\d{1,3})(:declines)?$/.exec(action);
  return match?.[1] === undefined ? undefined : { option: match[1], declines: match[2] !== undefined };
}

export interface NoticeDisplay {
  readonly title: string;
  readonly body: string;
  /** One notification per notice: a repeated delivery replaces it instead of stacking. */
  readonly tag: string;
  readonly data: PushNotice;
  readonly actions: readonly { readonly action: string; readonly title: string }[];
  readonly requireInteraction: boolean;
}

/** What the host said about a notice over the push stream: its prompt's rows and what it is about; nothing when not asked. */
export type NoticeAbout = Pick<Extract<PushHostLine, { readonly t: "notice" }>, "prompt" | "context">;

/**
 * The rows a notification offers, at most `max`: all of them when they fit; otherwise the first rows that do not
 * decline and the agent's No row last, so declining stays one tap. A tap on the notice itself opens every row.
 */
function rowActions(prompt: NoticePrompt, max: number) {
  const fits = prompt.options.length <= max;
  const no = prompt.options.find((option) => option.declines);
  const rows = fits
    ? prompt.options
    : [
        ...prompt.options.filter((option) => !option.declines).slice(0, no === undefined ? max : max - 1),
        ...(no === undefined ? [] : [no]),
      ];
  return rows.map((option) => ({ action: optionAction(option.id, option.declines), title: option.label }));
}

/**
 * What the service worker shows. The payload names nothing, by design; the title and body come from what the host
 * said about the notice over the push stream (#1908), and read the plain sentence when it said nothing or was not
 * reached. A permission or a question whose prompt the host named offers its own rows; a permission from a host that
 * names none offers Allow and Deny; anything else (several steps, boxes, typed text) offers none and a tap opens the card.
 */
export function noticeDisplay(
  notice: PushNotice,
  about: NoticeAbout = {},
  max: number = DEFAULT_MAX_ACTIONS,
): NoticeDisplay {
  const asks = notice.k === "permission" || notice.k === "input";
  const actions =
    asks && about.prompt !== undefined
      ? rowActions(about.prompt, max)
      : notice.k === "permission"
        ? ANSWER_ACTIONS
        : [];
  const { title, body } =
    notice.k === "test" ? { title: "Doriterm", body: TEST_BODY } : noticeText(notice.k, about.context);
  return { title, body, tag: notice.n, data: notice, actions, requireInteraction: asks };
}
