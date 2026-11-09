import { type NoticeText, noticeText as contextText } from "@doriface/protocol";
import { Notification } from "electron";
import type { DesktopNotice, NoticeAnswer } from "../shared/bridge.ts";
import { showAndAnswer, type Wait } from "./notice-answer.ts";

const TEST_TEXT: NoticeText = { title: "Doriterm", body: "Notifications on this computer work." };

/**
 * A notification's two lines, as the web app's push notices read them (#1908): the terminal, its space and machine
 * on the title, the state and what the agent asks on the body, from a context the IPC gate parsed and scrubbed; the
 * plain sentence when the page knew nothing. No command, output or path reaches the OS unscrubbed.
 */
export const noticeText = (notice: DesktopNotice): NoticeText =>
  notice.kind === "test" ? TEST_TEXT : contextText(notice.kind, notice.context);

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
