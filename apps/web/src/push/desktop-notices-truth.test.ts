import { describe, expect, test } from "bun:test";
import { DEFAULT_PUSH_PREFS } from "@doriface/protocol";
import { done, REFUSAL_REPORT_MS, retryDelay, rig, settled, status, terminal } from "./desktop-notices-rig.ts";
import type { NoticeAuthorization } from "./notice-bridge.ts";

describe("what the Notifications tab can tell the truth about (#769)", () => {
  test("load reads the OS's authorization as the browser would name it; a shell that cannot read one says nothing", async () => {
    const cases: readonly [NoticeAuthorization, NotificationPermission | null][] = [
      ["authorized", "granted"],
      ["denied", "denied"],
      ["not-determined", "default"],
      ["unknown", null],
    ];
    await Promise.all(
      cases.map(async ([authorization, permission]) => {
        const { notices } = rig({ authorization });
        await notices.load();
        expect(notices.view).toMatchObject({ permission, support: "supported", busy: null, error: null });
      }),
    );
  });

  test("a notice the OS did not take is one error on the tab per minute, not one per event", async () => {
    const { notices, feed, tick } = rig({ answer: { accepted: false, reason: "muted by a focus mode" } });
    await notices.turnOn();
    const events = await feed();
    events.emit(status("t1", done));
    await settled();
    expect(notices.view.error).toBe("Could not show a notification. muted by a focus mode");
    await notices.load();
    expect(notices.view.error).toBeNull();
    events.emit(status("t2", done));
    await settled();
    expect(notices.view.error).toBeNull();
    tick(REFUSAL_REPORT_MS);
    events.emit(status("t3", done));
    await settled();
    expect(notices.view.error).toBe("Could not show a notification. muted by a focus mode");
  });

  test("a failed subscribe is tried again, later each time, and the tab says so until the feed opens", async () => {
    const { notices, feed, fire, pending, subscribes } = rig({ failing: 2, terminals: [terminal("t1", done)] });
    await notices.turnOn();
    await settled();
    expect(notices.view.retry).toEqual({ reason: "the core is busy", inMs: retryDelay(0) });
    await fire();
    expect(notices.view.retry).toEqual({ reason: "the core is busy", inMs: retryDelay(1) });
    expect(retryDelay(1)).toBeGreaterThan(retryDelay(0));
    expect(retryDelay(30)).toBe(retryDelay(31));
    await fire();
    await feed();
    await settled();
    expect(subscribes()).toBe(3);
    expect(notices.view).toMatchObject({ retry: null, waiting: 1 });
    expect(pending()).toHaveLength(0);
  });

  test("Turn off while a retry waits cancels it, so no feed opens later", async () => {
    const { notices, feeds, timers } = rig({ failing: 1 });
    await notices.turnOn();
    await settled();
    expect(notices.view.retry).not.toBeNull();
    await notices.turnOff();
    expect(notices.view.retry).toBeNull();
    expect(timers.map((timer) => timer.cancelled)).toEqual([true]);
    await settled();
    expect(feeds).toHaveLength(0);
  });

  test("the agents already waiting are counted as this device would hear them, and never announced", async () => {
    const terminals = [
      terminal("t1", { state: "blocked" }),
      terminal("t2", done),
      terminal("t3", { state: "working" }),
      terminal("box/t4", { state: "error" }),
      { ...terminal("t5", done), state: "finished" as const },
    ];
    const { notices, feed, shown, connection } = rig({ terminals });
    expect(notices.view.waiting).toBeNull();
    await notices.turnOn();
    const events = await feed();
    await settled();
    expect(notices.view.waiting).toBe(3);
    expect(shown).toEqual([]);
    await notices.setPrefs({ events: DEFAULT_PUSH_PREFS.events, muted: ["machine:box"] });
    expect(notices.view.waiting).toBe(2);
    events.emit(status("t1", { state: "working" }));
    expect(notices.view.waiting).toBe(1);
    events.emit(status("t3", { state: "blocked" }));
    expect(notices.view.waiting).toBe(2);
    await settled();
    expect(shown).toEqual([{ kind: "input", terminal: "t3" }]);
    connection.move({ phase: "connecting", attempt: 1, stale: null });
    expect(notices.view.waiting).toBeNull();
  });
});
