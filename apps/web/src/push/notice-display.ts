import type { NoticeKind, NoticePrompt, PushNotice } from "@doriface/protocol";

const BODY: Readonly<Record<NoticeKind, string>> = {
  input: "An agent is waiting for your input.",
  permission: "An agent is asking for permission.",
  done: "An agent finished its turn.",
  error: "An agent stopped with an error.",
  test: "Notifications from this host work.",
};

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
 * What the service worker shows: a fixed text per kind; the payload holds nothing more, by design. A permission or a
 * question whose prompt the host named over the push stream offers its own rows; a permission from a host that names
 * none offers Allow and Deny; anything else (several steps, boxes, typed text) offers none and a tap opens the card.
 */
export function noticeDisplay(
  notice: PushNotice,
  prompt?: NoticePrompt,
  max: number = DEFAULT_MAX_ACTIONS,
): NoticeDisplay {
  const asks = notice.k === "permission" || notice.k === "input";
  const actions =
    asks && prompt !== undefined ? rowActions(prompt, max) : notice.k === "permission" ? ANSWER_ACTIONS : [];
  return {
    title: "Doriterm",
    body: BODY[notice.k],
    tag: notice.n,
    data: notice,
    actions,
    requireInteraction: asks,
  };
}
