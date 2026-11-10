import { type NoticeText, noticeText as textOf } from "@doriface/protocol";
import { Notification } from "electron";
import type { DesktopNotice, NoticeAnswer } from "../shared/bridge.ts";
import { showAndAnswer, type Wait } from "./notice-answer.ts";

/**
 * What the OS shows, as the web app's notices write it (#1908): `agent@machine`, then where and what it waits on, from
 * the notice's cleaned context; with none, the fixed text per kind. A test speaks of this computer.
 */
export const noticeText = (notice: DesktopNotice): NoticeText =>
  notice.kind === "test" && notice.context === undefined
    ? { title: "Doriterm", body: "Notifications on this computer work." }
    : textOf(notice.kind, notice.context);

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
