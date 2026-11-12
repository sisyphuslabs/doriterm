import { describe, expect, spyOn, test } from "bun:test";
import { readNoticeAuthorization } from "../src/main/notice-authorization.ts";

const preferences = (settings: () => unknown): object => ({ getNotificationSettings: settings });
const read = (authorizationStatus: unknown) => readNoticeAuthorization(preferences(() => ({ authorizationStatus })));

describe("the OS's notification authorization, read from systemPreferences", () => {
  test("each UNAuthorizationStatus the OS can give, by name", async () => {
    expect(await read("authorized")).toBe("authorized");
    expect(await read("provisional")).toBe("authorized");
    expect(await read("ephemeral")).toBe("authorized");
    expect(await read("denied")).toBe("denied");
    expect(await read("not-determined")).toBe("not-determined");
    expect(await read("restricted")).toBe("unknown");
    expect(await read(undefined)).toBe("unknown");
  });

  test("a shell without the call, one that throws, or one answering no object is unknown", async () => {
    expect(await readNoticeAuthorization({ getMediaAccessStatus: () => "granted" })).toBe("unknown");
    expect(
      await readNoticeAuthorization(
        preferences(() => {
          throw new Error("not on this platform");
        }),
      ),
    ).toBe("unknown");
    expect(await readNoticeAuthorization(preferences(() => "authorized"))).toBe("unknown");
  });

  test("the native addon answers even when Electron has no notification settings reader", async () => {
    let status = "denied";
    const addon = { noticeAuthorization: async () => status };
    expect(await readNoticeAuthorization({}, addon)).toBe("denied");
    status = "not-determined";
    expect(await readNoticeAuthorization({}, addon)).toBe("not-determined");
    status = "granted";
    expect(await readNoticeAuthorization({}, addon)).toBe("authorized");
    status = "unrecognized";
    expect(await readNoticeAuthorization({}, addon)).toBe("unknown");
  });

  test("native authorization wins over reflection and is read again after a settings change", async () => {
    let status = "denied";
    const addon = { noticeAuthorization: async () => status };
    const shell = preferences(() => ({ authorizationStatus: "authorized" }));
    expect(await readNoticeAuthorization(shell, addon)).toBe("denied");
    status = "granted";
    expect(await readNoticeAuthorization(shell, addon)).toBe("authorized");
  });

  test("denied while the app's own request is unanswered is no refusal yet (#1958); without one, denied stands", async () => {
    const denied = { noticeAuthorization: async () => "denied" };
    expect(await readNoticeAuthorization({}, denied, () => true)).toBe("not-determined");
    expect(await readNoticeAuthorization({}, denied, () => false)).toBe("denied");
    expect(await readNoticeAuthorization({}, denied)).toBe("denied");
    const granted = { noticeAuthorization: async () => "granted" };
    expect(await readNoticeAuthorization({}, granted, () => true)).toBe("authorized");
  });

  test("a native read that fails falls back to reflection or unknown", async () => {
    const addon = {
      noticeAuthorization: async () => {
        throw new Error("native read unavailable");
      },
    };
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await readNoticeAuthorization({}, addon)).toBe("unknown");
      expect(log).toHaveBeenCalledTimes(1);
      expect(
        await readNoticeAuthorization(
          preferences(() => {
            expect(log).toHaveBeenCalledTimes(2);
            return { authorizationStatus: "denied" };
          }),
          addon,
        ),
      ).toBe("denied");
    } finally {
      log.mockRestore();
    }
  });
});
