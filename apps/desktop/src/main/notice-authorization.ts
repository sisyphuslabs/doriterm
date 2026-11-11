import type { NoticeAuthorization } from "../shared/bridge.ts";
import type { NoticeAuthorizationAddon } from "./notice-addon.ts";

/** UNAuthorizationStatus by name: the two provisional grants show notices too, so they read as authorized. */
function authorizationOf(status: unknown): NoticeAuthorization {
  switch (status) {
    case "granted":
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
 * Read the app's macOS authorization without asking for permission. The native addon answers asynchronously on every
 * read (including Check again); absent that addon, retain the reflected shell API and unknown fallback. macOS can read
 * denied while the app's own request is on screen unanswered (#1958): that is no refusal yet, so it reads undecided.
 */
export async function readNoticeAuthorization(
  preferences: object,
  addon?: NoticeAuthorizationAddon,
  requestPending: () => boolean = () => false,
): Promise<NoticeAuthorization> {
  const authorization = await readStanding(preferences, addon);
  return authorization === "denied" && requestPending() ? "not-determined" : authorization;
}

async function readStanding(preferences: object, addon?: NoticeAuthorizationAddon): Promise<NoticeAuthorization> {
  if (addon !== undefined) {
    try {
      return authorizationOf(await addon.noticeAuthorization());
    } catch (error) {
      console.log(`notification authorization unavailable: ${error instanceof Error ? error.message : String(error)}`);
      // A native read that is unavailable must not break Settings; try the shell's reader below.
    }
  }
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
