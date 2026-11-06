import type { NoticeAuthorization } from "../shared/bridge.ts";

/** UNAuthorizationStatus by name: the two provisional grants show notices too, so they read as authorized. */
function authorizationOf(status: unknown): NoticeAuthorization {
  switch (status) {
    case "authorized":
    case "provisional":
    case "ephemeral":
      return "authorized";
    case "denied":
      return "denied";
    case "not-determined":
      return "not-determined";
    default:
      return "unknown";
  }
}

/**
 * This app's notification authorization, read through `systemPreferences.getNotificationSettings()` on a shell that
 * has it. Electron 45's systemPreferences has no such member, in its typings and in the method table of its framework
 * binary alike, so there this answers `unknown`: the OS decides, and a refused show (notice.ts) is the one signal left.
 */
export function readNoticeAuthorization(preferences: object): NoticeAuthorization {
  const read: unknown = Reflect.get(preferences, "getNotificationSettings");
  if (typeof read !== "function") return "unknown";
  try {
    const settings: unknown = Reflect.apply(read, preferences, []);
    if (typeof settings !== "object" || settings === null) return "unknown";
    return authorizationOf(Reflect.get(settings, "authorizationStatus"));
  } catch {
    return "unknown";
  }
}
