import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface NoticeAuthorizationAddon {
  noticeAuthorization(): Promise<unknown>;
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
      return { noticeAuthorization: async () => Reflect.apply(read, addon, []) };
    }
  } catch (error) {
    console.log(`notification authorization unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return undefined;
}
