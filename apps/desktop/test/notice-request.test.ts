import { describe, expect, spyOn, test } from "bun:test";
import { readNoticeAuthorization } from "../src/main/notice-authorization.ts";
import { NoticeRequest, noticesSupported } from "../src/main/notice-request.ts";

/** The native addon, its reads answering `status()` and each permission request held until the test answers it. */
function nativeAddon(status: () => string) {
  const requests: ((answer: string) => void)[] = [];
  return {
    requests,
    noticeAuthorization: async () => status(),
    requestNoticeAuthorization: () => new Promise<unknown>((resolve) => requests.push(resolve)),
  };
}

/** Electron's Notification class as far as a support check goes, counting the checks. */
function electronNotification(supported: boolean) {
  const notification = {
    checks: 0,
    isSupported() {
      notification.checks += 1;
      return supported;
    },
  };
  return notification;
}

describe("what makes the app's first request for notification permission (#1958)", () => {
  test("Settings' load on macOS asks Electron nothing and requests nothing: it only reads", async () => {
    // Electron's macOS presenter requests authorization as it is created, and isSupported() is what creates it.
    const notification = electronNotification(true);
    const addon = nativeAddon(() => "not-determined");
    const request = new NoticeRequest(addon);
    const [supported, authorization] = await Promise.all([
      noticesSupported("darwin", notification),
      readNoticeAuthorization({}, addon, () => request.pending),
    ]);
    expect({ supported, authorization }).toEqual({ supported: true, authorization: "not-determined" });
    expect(notification.checks).toBe(0);
    expect(addon.requests).toHaveLength(0);
  });

  test("elsewhere Electron says whether notices can show", () => {
    const linux = electronNotification(false);
    expect(noticesSupported("linux", linux)).toBe(false);
    expect(linux.checks).toBe(1);
    expect(noticesSupported("win32", electronNotification(true))).toBe(true);
  });

  test("the first notice asks once; denied reads as undecided until the OS answers, then its answer stands", async () => {
    let status = "denied";
    const addon = nativeAddon(() => status);
    const request = new NoticeRequest(addon);
    const read = () => readNoticeAuthorization({}, addon, () => request.pending);
    expect(await read()).toBe("denied");
    const asked = request.ask();
    expect(request.ask()).toBe(asked);
    expect(addon.requests).toHaveLength(1);
    expect(await read()).toBe("not-determined");
    addon.requests[0]?.("denied");
    await asked;
    expect(await read()).toBe("denied");
    status = "granted";
    expect(await read()).toBe("authorized");
    void request.ask();
    expect(addon.requests).toHaveLength(1);
  });

  test("a request that fails ends the wait; with no request to make, nothing waits", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const failing = new NoticeRequest({
        noticeAuthorization: async () => "denied",
        requestNoticeAuthorization: async () => {
          throw new Error("no app identity");
        },
      });
      await failing.ask();
      expect(failing.pending).toBe(false);
      expect(log).toHaveBeenCalledTimes(1);
      const older = new NoticeRequest({ noticeAuthorization: async () => "denied" });
      await older.ask();
      expect(older.pending).toBe(false);
      const none = new NoticeRequest(undefined);
      await none.ask();
      expect(none.pending).toBe(false);
    } finally {
      log.mockRestore();
    }
  });
});
