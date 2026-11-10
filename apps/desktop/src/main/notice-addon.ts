import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface NoticeAuthorizationAddon {
  noticeAuthorization(): Promise<unknown>;
  /** Asks the OS for permission and settles when it answers: at once when it has an answer, else when its prompt is. */
  requestNoticeAuthorization?(): Promise<unknown>;
}

/** Notifications share speech.node, but need neither dictation's usage strings nor a microphone/speech grant. */
export function loadNoticeAuthorization(
  path: string,
  load: (path: string) => unknown = require,
): NoticeAuthorizationAddon | undefined {
  try {
    const addon = load(path);
    if (
      typeof addon === "object" &&
      addon !== null &&
      "noticeAuthorization" in addon &&
      typeof addon.noticeAuthorization === "function"
    ) {
      const read = addon.noticeAuthorization;
      const request: unknown = Reflect.get(addon, "requestNoticeAuthorization");
      return {
        noticeAuthorization: async () => Reflect.apply(read, addon, []),
        // An addon built before #1958 has no request: notices then show as before, with no request of the app's known.
        ...(typeof request === "function"
          ? { requestNoticeAuthorization: async () => Reflect.apply(request, addon, []) }
          : {}),
      };
    }
  } catch (error) {
    console.log(`notification authorization unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return undefined;
}
