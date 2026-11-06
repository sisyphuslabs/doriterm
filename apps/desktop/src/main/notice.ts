import { Notification } from "electron";
import type { DesktopNotice, NoticeAnswer, NoticeKind } from "../shared/bridge.ts";
import { showAndAnswer, type Wait } from "./notice-answer.ts";

/** The fixed text per kind, as the web app's notices show it: no command, output or machine ever reaches the OS. */
const BODY: Readonly<Record<NoticeKind, string>> = {
  input: "An agent is waiting for your input.",
  permission: "An agent is asking for permission.",
  done: "An agent finished its turn.",
  error: "An agent stopped with an error.",
  test: "Notifications on this computer work.",
};

export interface NoticeText {
  readonly title: string;
  readonly body: string;
}

export const noticeText = (notice: DesktopNotice): NoticeText => ({ title: "Doriterm", body: BODY[notice.kind] });

/** Shown notifications, held until clicked or closed: one only referenced by the OS can be collected with its click. */
const live = new Set<Notification>();

export const noticesSupported = (): boolean => Notification.isSupported();

/** Shows one notification and answers whether the OS took it (notice-answer.ts); a click opens its terminal. */
export function showNotice(
  notice: DesktopNotice,
  open: (terminal: string | null) => void,
  wait?: Wait,
): Promise<NoticeAnswer> {
  const shown = new Notification(noticeText(notice));
  live.add(shown);
  shown.once("click", () => {
    live.delete(shown);
    open(notice.terminal);
  });
  shown.once("close", () => live.delete(shown));
  return showAndAnswer(shown, wait);
}
