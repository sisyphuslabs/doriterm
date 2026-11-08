import { describe, expect, test } from "bun:test";
import { defaultKeymap } from "./defaults.ts";
import { resolveKeymap } from "./keymap.ts";
import { shortcutGroups } from "./shortcut-groups.ts";

describe("shortcutGroups", () => {
  test("herdr-app's help chords open the dialog on both platforms", () => {
    expect(defaultKeymap("mac").get("super+/")).toBe("app.help");
    expect(defaultKeymap("mac").get("shift+super+/")).toBe("app.help");
    expect(defaultKeymap("other").get("ctrl+shift+/")).toBe("app.help");
  });

  test("lists the person's own keys, App then Terminal, and leaves out actions with none", () => {
    const keymap = resolveKeymap(
      "other",
      new Map<string, string | null>([
        ["ctrl+shift+p", null],
        ["ctrl+alt+k", "app.palette"],
        ["ctrl+alt+u", "send:\u0015"],
      ]),
    );
    const groups = shortcutGroups(keymap, "other");
    expect(groups.map((group) => group.title)).toEqual(["App", "Terminal"]);
    const rows = groups.flatMap((group) => group.rows);
    expect(rows.find((row) => row.id === "app.palette")?.chords).toEqual([["Ctrl", "Alt", "K"]]);
    expect(rows.find((row) => row.id === "send:\u0015")?.label).toBe("Send ^U (delete to line start)");
    expect(rows.some((row) => row.id === "voice.dictate")).toBe(false);
  });
});
