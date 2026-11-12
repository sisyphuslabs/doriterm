import { describe, expect, test } from "bun:test";
import { noticeControls } from "./notice-controls.ts";

const DESKTOP = true;
const WEB = false;

describe("Settings > Notifications controls", () => {
  test("off, on, and busy keep the controls they had", () => {
    expect(noticeControls({ on: false, busy: null, permission: null }, DESKTOP)).toEqual({
      actions: ["turn-on"],
      turnOnDisabled: false,
      editable: false,
      running: null,
    });
    expect(noticeControls({ on: true, busy: null, permission: "granted" }, DESKTOP)).toEqual({
      actions: ["turn-off"],
      turnOnDisabled: false,
      editable: true,
      running: null,
    });
    expect(noticeControls({ on: true, busy: "check-again", permission: null }, DESKTOP).editable).toBe(false);
    expect(noticeControls({ on: false, busy: null, permission: "denied" }, WEB)).toEqual({
      actions: ["turn-on"],
      turnOnDisabled: true,
      editable: false,
      running: null,
    });
  });

  test("only the action whose work is still running spins, not every action on the row (#1152)", () => {
    const denied = noticeControls({ on: true, busy: "check-again", permission: "denied" }, DESKTOP);
    expect(denied.actions).toEqual(["check-again", "turn-off"]);
    expect(denied.running).toBe("check-again");
    expect(noticeControls({ on: true, busy: "turn-off", permission: "denied" }, DESKTOP).running).toBe("turn-off");
    // Send test started the test it waits on, so its button spins (#1893); a save or a move belongs to no button.
    expect(noticeControls({ on: true, busy: "test", permission: "granted" }, DESKTOP).running).toBe("test");
    expect(noticeControls({ on: true, busy: "save", permission: "granted" }, DESKTOP).running).toBeNull();
    expect(noticeControls({ on: true, busy: "move", permission: "granted" }, DESKTOP).running).toBeNull();
  });

  test("denied by the OS while on: the remedy and Turn off together, and nothing else can be changed (#796)", () => {
    expect(noticeControls({ on: true, busy: null, permission: "denied" }, DESKTOP)).toEqual({
      actions: ["check-again", "turn-off"],
      turnOnDisabled: false,
      editable: false,
      running: null,
    });
    expect(noticeControls({ on: false, busy: null, permission: "denied" }, DESKTOP)).toEqual({
      actions: ["check-again"],
      turnOnDisabled: false,
      editable: false,
      running: null,
    });
  });
});
