import { describe, expect, test } from "bun:test";
import { type PresenceSink, reportShown, shownPane } from "./use-push-presence.ts";

const recorder = () => {
  const told: (string | null)[] = [];
  const sink: PresenceSink = { focus: (terminal) => void told.push(terminal) };
  return { told, sink };
};

describe("the pane this device reports as shown (#993)", () => {
  // The sheet and the dialog both set ActionsPaused (router.tsx: `value={settings}`): one input stands for both.
  test("opening Settings tells both sinks no pane is shown, and closing it tells them the focused pane again", () => {
    const push = recorder();
    const desktop = recorder();
    for (const underSettings of [false, true, false])
      reportShown(shownPane("t1", underSettings, true), [push.sink, desktop.sink]);
    expect(push.told).toEqual(["t1", null, "t1"]);
    expect(desktop.told).toEqual(["t1", null, "t1"]);
  });

  test("a page that is not seen shows no pane, with Settings open or not", () => {
    expect(shownPane("t1", false, false)).toBeNull();
    expect(shownPane("t1", true, false)).toBeNull();
  });

  test("without the desktop app the push stream alone is told", () => {
    const push = recorder();
    reportShown(shownPane("t1", false, true), [push.sink, null]);
    expect(push.told).toEqual(["t1"]);
  });
});
