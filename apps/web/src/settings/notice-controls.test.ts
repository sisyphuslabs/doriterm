import { describe, expect, test } from "bun:test";
import { noticeControls } from "./notice-controls.ts";

const DESKTOP = true;
const WEB = false;

describe("Settings > Notifications controls", () => {
  test("off, on, and busy keep the controls they had", () => {
    expect(noticeControls({ on: false, busy: false, permission: null }, DESKTOP)).toEqual({
      actions: ["turn-on"],
      turnOnDisabled: false,
      editable: false,
    });
    expect(noticeControls({ on: true, busy: false, permission: "granted" }, DESKTOP)).toEqual({
      actions: ["turn-off"],
      turnOnDisabled: false,
      editable: true,
    });
    expect(noticeControls({ on: true, busy: true, permission: null }, DESKTOP).editable).toBe(false);
    expect(noticeControls({ on: false, busy: false, permission: "denied" }, WEB)).toEqual({
      actions: ["turn-on"],
      turnOnDisabled: true,
      editable: false,
    });
  });

  test("denied by the OS while on: the remedy and Turn off together, and nothing else can be changed (#796)", () => {
    expect(noticeControls({ on: true, busy: false, permission: "denied" }, DESKTOP)).toEqual({
      actions: ["check-again", "turn-off"],
      turnOnDisabled: false,
      editable: false,
    });
    expect(noticeControls({ on: false, busy: false, permission: "denied" }, DESKTOP)).toEqual({
      actions: ["check-again"],
      turnOnDisabled: false,
      editable: false,
    });
  });
});
