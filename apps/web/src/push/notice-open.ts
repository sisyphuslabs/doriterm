import { isNoticeId } from "@doriface/protocol";
import { useEffect, useSyncExternalStore } from "react";
import { nativePush } from "../native/shell.ts";
import { noticeBridge } from "./notice-bridge.ts";
import type { PageAnswer } from "./notice-click.ts";
import { pushChannel } from "./push-channel.ts";
import { answerFromPage, whenVisible } from "./prompt-answer.ts";

export interface PendingNotice {
  readonly id: string;
  readonly host: string;
  /** Allow, or one of the prompt's rows, was tapped on the notification: the page sends it once visible. */
  readonly answer: PageAnswer | undefined;
  /**
   * Deny was tapped on an app's notification (#705): the apps hold no session to the host, so the page sends it once
   * visible, through the same check as the service worker's Deny.
   */
  readonly deny: boolean;
}

/** A clicked desktop notification names its terminal itself: no host round trip. */
interface ClickedTerminal {
  readonly terminal: string;
}

let pending: PendingNotice | ClickedTerminal | null = null;
const listeners = new Set<() => void>();
const set = (next: PendingNotice | ClickedTerminal | null): void => {
  pending = next;
  for (const listener of listeners) listener();
};

/** Whether a tapped notice is waiting to open its pane: it, not the phone's remembered place, decides what a start shows. */
export const hasPendingNotice = (): boolean => pending !== null;

/** An app is asking for the tap that launched it: until it answers, a start cannot tell whether a notice decides it. */
let launchPending = false;

/**
 * A notice launched this app. Unlike the pending notice, which its pane takes as soon as a render runs, this stays, so
 * the start decided after the launch tap answers still sees that a notice decides it.
 */
let launchNotice = false;
export const hasLaunchNotice = (): boolean => launchNotice;
const setLaunchPending = (next: boolean): void => {
  launchPending = next;
  for (const listener of listeners) listener();
};

/** Whether the tap that launched an app is still unknown; a browser and the desktop app never wait for one. */
export function useLaunchTapPending(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => launchPending,
    () => false,
  );
}

/** The answer a tapped action left in the address: `allow`, or `option:<id>` for one of the prompt's rows. */
function answerOf(value: string | null): PageAnswer | undefined {
  if (value === "allow") return { kind: "allow" };
  const option = /^option:(\d{1,3})$/.exec(value ?? "")?.[1];
  return option === undefined ? undefined : { kind: "option", option };
}

/** A notice a tap opened the app with (`/?notice=<id>&host=<hostId>[&answer=allow|deny|option:<id>]`), or null. */
export function noticeOf(url: URL): PendingNotice | null {
  const id = url.searchParams.get("notice");
  if (!isNoticeId(id)) return null;
  const answer = url.searchParams.get("answer");
  return { id, host: url.searchParams.get("host") ?? "", answer: answerOf(answer), deny: answer === "deny" };
}

/**
 * A tapped notification's address (`/?notice=...`), handed over by an app or by the service worker: the notice waits for
 * the workspace, which the page goes to.
 */
function openTapped(url: string, toWorkspace: () => void): boolean {
  if (!URL.canParse(url, location.origin)) return false;
  const notice = noticeOf(new URL(url, location.origin));
  if (notice === null) return false;
  set(notice);
  toWorkspace();
  return true;
}

/**
 * The iOS and Android apps hand a tapped notification to the page: the one that launched the app, then each later one.
 * Resolves once the launch tap has answered and the start no longer waits for it.
 */
export async function listenForAppNotices(toWorkspace: () => void, plugin = nativePush()): Promise<void> {
  if (plugin === null) return;
  void plugin.addListener("noticeTap", (tap) => openTapped(tap.url, toWorkspace));
  // The launch notice is kept before the wait ends, so a start that waited sees it (#1494's "a tapped notice still
  // wins") even when a render in between has already handed the pending notice to its pane.
  setLaunchPending(true);
  await plugin
    .takeLaunchTap()
    .then(({ tap }) => {
      launchNotice = tap !== null && openTapped(tap.url, toWorkspace);
      return launchNotice;
    })
    .finally(() => setLaunchPending(false));
}

/** Reads a tapped notice from the address once and takes it out of the address bar and history. */
export function captureNotice(): void {
  const url = new URL(location.href);
  const notice = noticeOf(url);
  if (notice === null) return;
  url.searchParams.delete("notice");
  url.searchParams.delete("host");
  url.searchParams.delete("answer");
  history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  set(notice);
}

/**
 * A tap while the app is open: the service worker focuses this window and posts the notice's address. The pane opens
 * in the workspace, so a window showing another screen (Settings) goes there first, through `toWorkspace`.
 */
export function listenForNotices(toWorkspace: () => void): void {
  navigator.serviceWorker?.addEventListener("message", (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (typeof data !== "object" || data === null || Reflect.get(data, "type") !== "doriface-notice") return;
    const url = Reflect.get(data, "url");
    if (typeof url === "string") openTapped(url, toWorkspace);
  });
}

/** A click on a desktop notification opens its pane in the workspace, reached through `toWorkspace`. */
export function listenForDesktopNotices(toWorkspace: () => void, scope: object = globalThis): void {
  noticeBridge(scope)?.onClick((terminal) => {
    if (terminal !== null) set({ terminal });
    toWorkspace();
  });
}

/**
 * Opens the pane a tapped notice is about: the push carried only an id, so the host is asked over the push stream
 * which terminal it was. A notice from another host, or one the host no longer knows, opens nothing more.
 */
export function useNoticeOpen(hostId: string | undefined, open: (address: string) => void): void {
  const notice = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => pending,
  );
  useEffect(() => {
    if (notice === null) return;
    set(null);
    if ("terminal" in notice) {
      open(notice.terminal);
      return;
    }
    if (hostId !== undefined && notice.host !== hostId) return;
    void openNotice(notice, open);
  }, [notice, hostId, open]);
}

async function openNotice(notice: PendingNotice, open: (address: string) => void): Promise<void> {
  let terminal: string | null = null;
  try {
    const reply = await pushChannel.requestOnce({ t: "notice", id: notice.id });
    if (reply.t === "notice") terminal = reply.terminal;
  } catch {
    // Without the push stream the app stays where it opened; the notice itself says what happened.
  }
  if (terminal === null) return;
  open(terminal);
  if (notice.deny) {
    await whenVisible(document);
    await pushChannel.requestOnce({ t: "answer", id: notice.id, answer: "deny" }).catch(() => undefined);
    return;
  }
  const answer = notice.answer;
  if (answer === undefined) return;
  await answerFromPage(
    terminal,
    () =>
      pushChannel.requestOnce(
        answer.kind === "allow"
          ? { t: "answer", id: notice.id, answer: "allow" }
          : { t: "choose", id: notice.id, option: answer.option },
      ),
    () => whenVisible(document),
  );
}
