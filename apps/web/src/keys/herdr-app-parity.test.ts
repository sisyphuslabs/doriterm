import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { defaultKeymap } from "./defaults.ts";
import { herdrAppDefaults } from "./herdr-app-defaults.ts";
import { BROWSER_TAB_FALLBACK, HERDR_APP_DIFFERENCES } from "./herdr-app-parity.ts";
import { herdrAppTable } from "./herdr-app-table.ts";

const platforms = ["mac", "other"] as const;

describe("doriface's default keymap against herdr-app's shipped key files", () => {
  test.each(platforms)(
    "on %s every herdr-app default is bound to herdr-app's action, or its difference is recorded",
    (platform) => {
      const keymap = defaultKeymap(platform);
      const recorded = new Map(HERDR_APP_DIFFERENCES[platform].map((entry) => [entry.chord, entry.doriface]));
      const unexplained = herdrAppDefaults(platform)
        .filter(({ trigger, action }) => keymap.get(trigger) !== action)
        .filter(({ chord, trigger }) => recorded.get(chord) !== (keymap.get(trigger) ?? null))
        .map(({ chord, action }) => `${chord} ${action}`);
      expect(unexplained).toEqual([]);
    },
  );

  test.each(platforms)(
    "on %s every recorded difference is one: a herdr-app chord doriface binds otherwise",
    (platform) => {
      const keymap = defaultKeymap(platform);
      const herdr = new Map(herdrAppDefaults(platform).map((entry) => [entry.chord, entry]));
      const stale = HERDR_APP_DIFFERENCES[platform]
        .filter(({ chord }) => {
          const entry = herdr.get(chord);
          return entry === undefined || keymap.get(entry.trigger) === entry.action;
        })
        .map(({ chord }) => chord);
      expect(stale).toEqual([]);
    },
  );

  test.each(platforms)(
    "on %s every browser-tab fallback names a herdr-app chord doriface binds as herdr-app does",
    (platform) => {
      const keymap = defaultKeymap(platform);
      const herdr = new Map(herdrAppDefaults(platform).map((entry) => [entry.chord, entry]));
      const wrong = Object.keys(BROWSER_TAB_FALLBACK[platform]).filter((chord) => {
        const entry = herdr.get(chord);
        return entry === undefined || keymap.get(entry.trigger) !== entry.action;
      });
      expect(wrong).toEqual([]);
    },
  );

  test("docs/keymap-herdr-app.md is the table this comparison generates (bun apps/web/scripts/keymap-table.ts)", () => {
    const doc = readFileSync(new URL("../../../../docs/keymap-herdr-app.md", import.meta.url), "utf8");
    expect(doc).toBe(herdrAppTable());
  });
});
