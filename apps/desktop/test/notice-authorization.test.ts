import { describe, expect, test } from "bun:test";
import { readNoticeAuthorization } from "../src/main/notice-authorization.ts";

const preferences = (settings: () => unknown): object => ({ getNotificationSettings: settings });
const read = (authorizationStatus: unknown) => readNoticeAuthorization(preferences(() => ({ authorizationStatus })));

describe("the OS's notification authorization, read from systemPreferences", () => {
  test("each UNAuthorizationStatus the OS can give, by name", () => {
    expect(read("authorized")).toBe("authorized");
    expect(read("provisional")).toBe("authorized");
    expect(read("ephemeral")).toBe("authorized");
    expect(read("denied")).toBe("denied");
    expect(read("not-determined")).toBe("not-determined");
    expect(read("restricted")).toBe("unknown");
    expect(read(undefined)).toBe("unknown");
  });

  test("a shell without the call, one that throws, or one answering no object is unknown", () => {
    expect(readNoticeAuthorization({ getMediaAccessStatus: () => "granted" })).toBe("unknown");
    expect(
      readNoticeAuthorization(
        preferences(() => {
          throw new Error("not on this platform");
        }),
      ),
    ).toBe("unknown");
    expect(readNoticeAuthorization(preferences(() => "authorized"))).toBe("unknown");
  });
});
