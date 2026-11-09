import type { NoticeContext } from "@doriface/protocol";
import type { Trigger } from "./notice-trigger.ts";

/** The OS's standing answer about the desktop app's notifications, as apps/desktop/src/shared/bridge.ts names it. */
export type NoticeAuthorization = "authorized" | "denied" | "not-determined" | "unknown";

/** Whether the OS took a notification, or why it did not. */
export type NoticeAnswer = { readonly accepted: true } | { readonly accepted: false; readonly reason: string };

/** The desktop shell's native notifications (apps/desktop/src/shared/bridge.ts), read as an untrusted boundary. */
export interface NoticeBridge {
  supported(): Promise<boolean>;
  permission(): Promise<NoticeAuthorization>;
  show(notice: {
    readonly kind: Trigger["kind"] | "test";
    readonly terminal: string | null;
    /** What it is about (#1908), for the notification's text; none for a test. */
    readonly context?: NoticeContext;
  }): Promise<NoticeAnswer>;
  onClick(listener: (terminal: string | null) => void): void;
}

/** The OS's authorization in the browser's permission vocabulary, which Settings > Notifications reads. */
export function permissionOf(authorization: NoticeAuthorization): NotificationPermission | null {
  switch (authorization) {
    case "authorized":
      return "granted";
    case "denied":
      return "denied";
    case "not-determined":
      return "default";
    case "unknown":
      return null;
  }
}

function authorizationOf(value: unknown): NoticeAuthorization {
  switch (value) {
    case "authorized":
    case "denied":
    case "not-determined":
      return value;
    default:
      return "unknown";
  }
}

const NO_ANSWER: NoticeAnswer = { accepted: false, reason: "the desktop app returned no answer" };

function answerOf(value: unknown): NoticeAnswer {
  if (typeof value !== "object" || value === null) return NO_ANSWER;
  const accepted: unknown = Reflect.get(value, "accepted");
  if (accepted === true) return { accepted: true };
  const reason: unknown = Reflect.get(value, "reason");
  return accepted === false && typeof reason === "string" ? { accepted: false, reason } : NO_ANSWER;
}

export function noticeBridge(scope: object = globalThis): NoticeBridge | null {
  const bridge: unknown = Reflect.get(scope, "doriface");
  if (typeof bridge !== "object" || bridge === null) return null;
  const method = (name: string): ((...args: unknown[]) => unknown) | null => {
    const found: unknown = Reflect.get(bridge, name);
    return typeof found === "function" ? (...args) => Reflect.apply(found, bridge, args) : null;
  };
  const supported = method("noticesSupported");
  const permission = method("noticePermission");
  const show = method("showNotice");
  const onClick = method("onNoticeClick");
  if (supported === null || permission === null || show === null || onClick === null) return null;
  return {
    supported: async () => (await supported()) === true,
    permission: async () => authorizationOf(await permission()),
    show: async (notice) => answerOf(await show(notice)),
    onClick: (listener) =>
      void onClick((terminal: unknown) => {
        if (terminal === null || typeof terminal === "string") listener(terminal);
      }),
  };
}
