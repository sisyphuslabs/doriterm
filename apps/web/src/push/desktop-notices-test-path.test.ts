import { describe, expect, test } from "bun:test";
import { DEFAULT_PUSH_PREFS } from "@doriface/protocol";
import { done, rig, terminal } from "./desktop-notices-rig.ts";

const ALL_OFF = { input: false, permission: false, done: false, error: false };

describe("Send test runs the checks an agent's notice passes (#796)", () => {
  test("with the feed open and this machine heard, it shows the test notice", async () => {
    const { notices, feed, shown } = rig();
    await notices.turnOn();
    await feed();
    await notices.test();
    expect(shown).toEqual([{ kind: "test", terminal: null }]);
    expect(notices.view).toMatchObject({ tested: true, error: null });
  });

  test("a feed still opening is waited for, as the first agent notice would be", async () => {
    const { notices, shown } = rig();
    await notices.turnOn();
    await notices.test();
    expect(shown).toEqual([{ kind: "test", terminal: null }]);
  });

  test("while off, or while the agents cannot be followed, it fails and shows nothing", async () => {
    const off = rig();
    await off.notices.test();
    expect(off.shown).toEqual([]);
    expect(off.notices.view).toMatchObject({
      tested: false,
      error: "Could not send a test notification. Notifications are off.",
    });

    const failing = rig({ failing: 1 });
    await failing.notices.turnOn();
    await failing.notices.test();
    expect(failing.shown).toEqual([]);
    expect(failing.notices.view.error).toBe(
      "Could not send a test notification. Doriterm is not following the agents: the core is busy.",
    );
  });

  test("every event turned off fails the test instead of passing it", async () => {
    const quiet = rig();
    await quiet.notices.turnOn();
    await quiet.notices.setPrefs({ ...DEFAULT_PUSH_PREFS, events: ALL_OFF });
    await quiet.notices.test();
    expect(quiet.shown).toEqual([]);
    expect(quiet.notices.view.error).toBe(
      "Could not send a test notification. Every event is turned off, so no agent would notify.",
    );
  });

  test("every machine heard muted refuses, naming this host's core by its hello and saying only machines running a terminal count (#1120, #1121, #1893)", async () => {
    const muted = rig();
    await muted.notices.turnOn();
    await muted.notices.setPrefs({ ...DEFAULT_PUSH_PREFS, muted: ["local"] });
    await muted.notices.test();
    expect(muted.shown).toEqual([]);
    expect(muted.notices.view.error).toBe(
      "Could not send a test notification. Notifications from dev-box are turned off, and no other machine is running a terminal right now.",
    );

    const all = rig({ terminals: [terminal("box/t1", done)] });
    await all.notices.turnOn();
    await all.notices.setPrefs({ ...DEFAULT_PUSH_PREFS, muted: ["local", "machine:box"] });
    await all.notices.test();
    expect(all.shown).toEqual([]);
    expect(all.notices.view.error).toBe(
      "Could not send a test notification. Notifications from every machine running a terminal right now are turned off.",
    );
  });

  test("a heard machine that is not muted passes the test while this host's core is muted (#1120)", async () => {
    const { notices, shown } = rig({ terminals: [terminal("box/t1", done)] });
    await notices.turnOn();
    await notices.setPrefs({ ...DEFAULT_PUSH_PREFS, muted: ["local"] });
    await notices.test();
    expect(shown).toEqual([{ kind: "test", terminal: null }]);
    expect(notices.view).toMatchObject({ tested: true, error: null });
  });
});
