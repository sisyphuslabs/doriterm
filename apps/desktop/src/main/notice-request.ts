import type { DesktopPlatform } from "../shared/bridge.ts";
import type { NoticeAuthorizationAddon } from "./notice-addon.ts";

/**
 * Whether this system can show notifications, answered without asking the OS for permission (#1958). On macOS,
 * Electron's `Notification.isSupported()` creates its notification presenter, and that presenter requests
 * authorization as it is made, so a support check from Settings raised the OS prompt before any notice. There the
 * presenter always exists, so the answer is yes without making it. Elsewhere a support check prompts for nothing.
 */
export const noticesSupported = (platform: DesktopPlatform, notification: { isSupported(): boolean }): boolean =>
  platform === "darwin" || notification.isSupported();

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The app's own request for notification permission, made with its first notice, once per run (#1958). macOS can read
 * denied while that prompt is on screen unanswered, so the app keeps whether its request is still waiting for an answer.
 */
export class NoticeRequest {
  readonly #addon: NoticeAuthorizationAddon | undefined;
  #asked: Promise<void> | undefined;
  #pending = false;

  constructor(addon: NoticeAuthorizationAddon | undefined) {
    this.#addon = addon;
  }

  /** The request was made and the OS has not answered it yet. */
  get pending(): boolean {
    return this.#pending;
  }

  /** Requests permission the first time and settles when the OS answers; an addon without the request asks nothing. */
  ask(): Promise<void> {
    if (this.#asked !== undefined) return this.#asked;
    const addon = this.#addon;
    if (addon?.requestNoticeAuthorization === undefined) return Promise.resolve();
    this.#pending = true;
    this.#asked = addon
      .requestNoticeAuthorization()
      .then(
        () => undefined,
        (error: unknown) => console.log(`notification permission request failed: ${message(error)}`),
      )
      .finally(() => {
        this.#pending = false;
      });
    return this.#asked;
  }
}
