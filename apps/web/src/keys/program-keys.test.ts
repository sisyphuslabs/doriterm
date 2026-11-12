import { describe, expect, test } from "bun:test";
import { defaultKeymap } from "./defaults.ts";
import { ALT_KEPT } from "./herdr-app-parity.ts";

/**
 * A program reads Alt+<key> for itself: Alt+arrows move words and walk answers (agent question UIs answer with them),
 * and Alt with a letter, digit or punctuation key is a Meta key in every shell and editor (Alt+. yanks the last
 * argument, Alt+<digit> is readline's numeric argument). A `send:` binding is fine — it hands the program a sequence —
 * but an app action on one of these takes the key away, which is what #1302 reported. The only app actions allowed
 * on an Alt chord are the herdr-app families listed, each with its reason, in `ALT_KEPT` (#1942).
 */
const ALT_ONLY = /^alt\+(shift\+)?[^+]+$/;
const ALT_ARROW = /^alt\+(shift\+)?(up|down|left|right)$/;

const appActions = (platform: "mac" | "other") =>
  [...defaultKeymap(platform)].filter(([trigger, action]) => ALT_ONLY.test(trigger) && !action.startsWith("send:"));

describe("the defaults leave a program its Alt keys", () => {
  for (const platform of ["mac", "other"] as const) {
    test(`${platform} binds no app action to Alt+arrow`, () => {
      const taken = appActions(platform)
        .filter(([trigger]) => ALT_ARROW.test(trigger))
        .map(([trigger, action]) => `${trigger} -> ${action}`);
      expect(taken, "Alt+arrows are the program's, not ours").toEqual([]);
    });

    test(`${platform} takes an Alt chord only for a family ALT_KEPT lists`, () => {
      const unlisted = appActions(platform)
        .filter(
          ([trigger, action]) =>
            !ALT_KEPT[platform].some((kept) => kept.trigger.test(trigger) && kept.action.test(action)),
        )
        .map(([trigger, action]) => `${trigger} -> ${action}`);
      expect(unlisted, "an Alt chord is a Meta key; list the family and its reason in ALT_KEPT, or leave it").toEqual(
        [],
      );
    });

    test(`${platform} lists no ALT_KEPT family the defaults do not bind`, () => {
      const stale = ALT_KEPT[platform]
        .filter(
          (kept) =>
            !appActions(platform).some(([trigger, action]) => kept.trigger.test(trigger) && kept.action.test(action)),
        )
        .map((kept) => String(kept.trigger));
      expect(stale).toEqual([]);
    });
  }
});
