import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { desktopUpdateSetting, type DesktopUpdateStatus } from "../desktop/update-setting.ts";
import { statusLine, UpdateChannelRow } from "./update-channel-row.tsx";

test("each updater state has its own line, and a failed check, a stall and a too-old build are told apart", () => {
  const lines: [DesktopUpdateStatus | null, string][] = [
    [null, "Updates come from get.doriterm.com."],
    [{ state: "current" }, "Doriterm is up to date."],
    [{ state: "downloading", version: "0.1.17", percent: 42 }, "Downloading Doriterm 0.1.17 (42%)."],
    [{ state: "ready", version: "0.1.17" }, "Doriterm 0.1.17 is downloaded; restart to install it."],
    [
      { state: "failed", reason: "check", message: "net::ERR_NAME_NOT_RESOLVED" },
      "The update check failed: net::ERR_NAME_NOT_RESOLVED",
    ],
    [
      {
        state: "failed",
        reason: "stalled",
        message: "The download of 0.1.17 stopped making progress; the next check tries again.",
      },
      "The download of 0.1.17 stopped making progress; the next check tries again.",
    ],
    [
      { state: "failed", reason: "below-floor", message: "Doriterm 0.1.9 is older than 0.1.10" },
      "Doriterm 0.1.9 is older than 0.1.10",
    ],
  ];
  for (const [status, line] of lines) expect(statusLine(status)).toBe(line);
});

test("the row is offered only by a shell that has an updater, and passes what it says through checked", async () => {
  expect(desktopUpdateSetting({})).toBeNull();
  expect(desktopUpdateSetting({ doriface: { updateChannel: async () => "beta" } })).toBeNull();
  const kept: unknown[] = [];
  const statuses: unknown[] = [];
  const setting = desktopUpdateSetting({
    doriface: {
      updateChannel: async () => "nightly",
      setUpdateChannel: async (channel: unknown) => kept.push(channel) > 0,
      checkForUpdates: async () => undefined,
      onUpdateStatus: (listener: (status: unknown) => void) => {
        listener({ state: "downloading", version: "0.1.17", percent: "x" });
        listener({ state: "failed", reason: "stalled" });
      },
    },
  });
  if (setting === null) throw new Error("a full bridge offers the setting");
  expect(await setting.channel()).toBeNull();
  expect(await setting.setChannel("beta")).toBe(true);
  expect(kept).toEqual(["beta"]);
  setting.onStatus((status) => statuses.push(status));
  expect(statuses).toEqual([{ state: "downloading", version: "0.1.17", percent: 0 }, null]);

  const html = renderToStaticMarkup(<UpdateChannelRow setting={setting} />);
  expect(html).toContain("Update channel");
  expect(html).toContain("Check now");
});
