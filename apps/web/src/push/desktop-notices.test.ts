import { describe, expect, test } from "bun:test";
import { DEFAULT_PUSH_PREFS } from "@doriface/protocol";
import {
  DESKTOP_NOTICES_KEY,
  done,
  parseSavedNotices,
  REPEAT_MS,
  rig,
  settled,
  status,
  terminal,
} from "./desktop-notices-rig.ts";

describe("the desktop app's native notifications", () => {
  test("off until Turn on: no feed is opened and nothing is shown", async () => {
    const { notices, feeds } = rig();
    expect(notices.view).toMatchObject({ on: false, support: "supported", prefs: DEFAULT_PUSH_PREFS });
    await Promise.resolve();
    expect(feeds).toHaveLength(0);
  });

  test("on: a turn that finishes, asks or fails is one notice naming its terminal; the snapshot stays quiet", async () => {
    const { notices, feed, shown, stored } = rig({ terminals: [terminal("t1", { state: "blocked" })] });
    await notices.turnOn();
    const events = await feed();
    events.emit(status("t1", { state: "blocked" }));
    events.emit(status("t2", done));
    events.emit(status("t3", { state: "blocked", kind: "permission" }));
    events.emit(status("t4", { state: "error" }, "box"));
    events.emit(status("t5", { state: "working" }));
    await settled();
    expect(shown).toEqual([
      { kind: "done", terminal: "t2" },
      { kind: "permission", terminal: "t3" },
      { kind: "error", terminal: "box/t4" },
    ]);
    expect(parseSavedNotices(stored.get(DESKTOP_NOTICES_KEY) ?? null).on).toBe(true);
  });

  test("a notice carries what the core says it is about; a core that cannot be read leaves the event's own words (#1908)", async () => {
    const asked: string[] = [];
    const { notices, feed, shown, contexts } = rig({
      look: async (_connection, hit) => {
        asked.push(`${hit.kind} ${hit.terminal}`);
        return hit.terminal === "t2"
          ? { title: "roster sync", space: "api-server", asks: "Which database should the migration target?" }
          : {};
      },
    });
    await notices.turnOn();
    const events = await feed();
    events.emit(status("t2", { state: "blocked", kind: "question" }));
    events.emit(status("t3", done, "box"));
    await settled();
    expect(asked).toEqual(["input t2", "done box/t3"]);
    expect(shown).toEqual([
      { kind: "input", terminal: "t2" },
      { kind: "done", terminal: "box/t3" },
    ]);
    expect(contexts).toEqual([
      { title: "roster sync", space: "api-server", asks: "Which database should the migration target?" },
      {},
    ]);
  });

  test("without a stand-in, a connection that cannot be called still shows the notice with the status's own words", async () => {
    const { notices, feed, contexts } = rig();
    await notices.turnOn();
    const events = await feed();
    events.emit(status("t1", { state: "error", msg: "exit 1" }, "box"));
    await settled();
    expect(contexts).toEqual([{ machine: "box", asks: "exit 1" }]);
  });

  test("an agent flapping back into the same state within 30 s is one notice", async () => {
    const { notices, feed, shown, tick } = rig();
    await notices.turnOn();
    const events = await feed();
    events.emit(status("t1", done));
    events.emit(status("t1", { state: "working" }));
    events.emit(status("t1", done));
    tick(REPEAT_MS);
    events.emit(status("t1", { state: "working" }));
    events.emit(status("t1", done));
    await settled();
    expect(shown).toEqual([
      { kind: "done", terminal: "t1" },
      { kind: "done", terminal: "t1" },
    ]);
  });

  test("a turned-off event, a muted machine and the pane in view show nothing", async () => {
    const { notices, feed, shown } = rig();
    await notices.turnOn();
    await notices.setPrefs({ events: { ...DEFAULT_PUSH_PREFS.events, done: false }, muted: ["machine:box"] });
    notices.focus("t3");
    const events = await feed();
    events.emit(status("t1", done));
    events.emit(status("t2", { state: "error" }, "box"));
    events.emit(status("t3", { state: "error" }));
    events.emit(status("t4", { state: "error" }));
    await settled();
    expect(shown).toEqual([{ kind: "error", terminal: "t4" }]);
  });

  test("Turn off and a dropped connection close the feed; a saved on follows the next connection", async () => {
    const saved = JSON.stringify({ on: true, prefs: DEFAULT_PUSH_PREFS });
    const { notices, feeds, feed, connection, reopen } = rig({ saved });
    expect(notices.view.on).toBe(true);
    const first = await feed();
    connection.move({ phase: "connecting", attempt: 1, stale: null });
    expect(first.closed).toBe(true);
    reopen();
    const second = await feed();
    expect(second).not.toBe(first);
    await notices.turnOff();
    expect(second.closed).toBe(true);
    expect(feeds).toHaveLength(2);
  });

  test("Send test shows a test notice; a refused one and a system without notifications say so", async () => {
    const working = rig();
    await working.notices.turnOn();
    await working.notices.test();
    expect(working.shown).toEqual([{ kind: "test", terminal: null }]);
    expect(working.notices.view).toMatchObject({ tested: true, error: null });

    const refused = rig({ answer: { accepted: false, reason: "it was refused" } });
    await refused.notices.turnOn();
    await refused.notices.test();
    expect(refused.notices.view.error).toBe("Could not send a test notification. it was refused");

    const none = rig({ supported: false });
    await none.notices.load();
    expect(none.notices.view.support).toBe("desktop-app");
  });

  test("saved settings that cannot be read are notifications off with every event", () => {
    for (const raw of [null, "{", "[]", JSON.stringify({ on: "yes", prefs: { events: 1 } })]) {
      expect(parseSavedNotices(raw)).toEqual({ on: false, prefs: DEFAULT_PUSH_PREFS });
    }
  });
});
