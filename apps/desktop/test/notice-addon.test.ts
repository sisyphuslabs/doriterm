import { describe, expect, test } from "bun:test";
import { loadNoticeAuthorization } from "../src/main/notice-addon.ts";
import { readNoticeAuthorization } from "../src/main/notice-authorization.ts";
import { speechAddonPath } from "../src/main/speech.ts";

describe("notification authorization from the packaged macOS addon", () => {
  test("uses the packaged speech.node path without dictation readiness or speech permission", async () => {
    const path = speechAddonPath(true, "/App/Contents/Resources", "/App");
    const paths: string[] = [];
    const addon = loadNoticeAuthorization(path, (file) => {
      paths.push(file);
      return {
        ready: () => false,
        status: "denied",
        async noticeAuthorization(this: { readonly status: string }) {
          return this.status;
        },
      };
    });
    expect(paths).toEqual(["/App/Contents/Resources/native/speech.node"]);
    expect(addon).toBeDefined();
    expect(await readNoticeAuthorization({}, addon)).toBe("denied");
  });

  test("the permission request is kept bound to the addon; an addon built without it still reads", async () => {
    const addon = loadNoticeAuthorization("/speech.node", () => ({
      answer: "granted",
      noticeAuthorization: async () => "not-determined",
      async requestNoticeAuthorization(this: { readonly answer: string }) {
        return this.answer;
      },
    }));
    expect(await addon?.requestNoticeAuthorization?.()).toBe("granted");
    const older = loadNoticeAuthorization("/speech.node", () => ({ noticeAuthorization: async () => "denied" }));
    expect(older?.requestNoticeAuthorization).toBeUndefined();
    expect(await readNoticeAuthorization({}, older)).toBe("denied");
  });

  test("an absent, older or malformed addon leaves the shell/unknown fallback usable", async () => {
    for (const value of [undefined, null, {}, { noticeAuthorization: true }]) {
      expect(loadNoticeAuthorization("/speech.node", () => value)).toBeUndefined();
    }
    const addon = loadNoticeAuthorization("/speech.node", () => {
      throw new Error("addon not built");
    });
    expect(addon).toBeUndefined();
    expect(await readNoticeAuthorization({}, addon)).toBe("unknown");
    expect(
      await readNoticeAuthorization({ getNotificationSettings: () => ({ authorizationStatus: "denied" }) }, addon),
    ).toBe("denied");
  });
});
