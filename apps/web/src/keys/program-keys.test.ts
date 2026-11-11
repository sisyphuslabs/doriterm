import { describe, expect, test } from "bun:test";
import { defaultKeymap } from "./defaults.ts";

/**
 * A program reads these for itself: Alt+arrows move words and walk answers (agent question UIs answer with them), and
 * Alt+<letter> is a Meta key in every shell and editor. A \`send:\` binding is fine — it hands the program a sequence —
 * but an app action on one of these takes the key away, which is what #1302 reported.
 */
const ALT_ARROW = /^alt\+(up|down|left|right)$/;
const ALT_LETTER = /^alt\+(shift\+)?[a-z]$/;

/**
 * The one family that keeps Alt+letters on purpose: Ghostty's vim-style pane keys, carried by herdr-app. A Linux or
 * Windows user who wants those letters for a program overrides them in Settings > Keyboard, which is a documented choice
 * rather than the silent theft this test exists to stop.
 */
const VIM_PANES = /^(pane\.(go|swap):)/;

describe("the defaults leave a program its Alt keys", () => {
  for (const platform of ["mac", "other"] as const) {
    test(`${platform} binds no app action to Alt+arrow`, () => {
      const taken = [...defaultKeymap(platform)]
        .filter(([trigger, action]) => ALT_ARROW.test(trigger) && !action.startsWith("send:"))
        .map(([trigger, action]) => `${trigger} -> ${action}`);
      expect(taken, "Alt+arrows are the program's, not ours").toEqual([]);
    });

    test(`${platform} takes Alt+letter for nothing but the vim pane keys`, () => {
      const taken = [...defaultKeymap(platform)]
        .filter(([trigger, action]) => ALT_LETTER.test(trigger) && !VIM_PANES.test(action))
        .map(([trigger, action]) => `${trigger} -> ${action}`);
      expect(taken, "Alt+letter is a Meta key; only the vim pane pair may hold it").toEqual([]);
    });
  }
});
