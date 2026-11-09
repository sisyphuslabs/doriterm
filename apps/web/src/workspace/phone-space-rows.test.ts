import type { Terminal } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import type { ListedSpace } from "./model.ts";
import { spaceSummary, spaceTabRows, switchTabRows } from "./phone-space-rows.ts";

const terminal = (address: string, fields: Partial<Terminal> = {}): Terminal => ({
  address,
  argv: ["sh"],
  cols: 80,
  rows: 24,
  created_ms: 0,
  cwd: "/work/website",
  labels: {},
  screen: "exact",
  state: "live",
  ...fields,
});
const said = (state: string, msg: string) => ({ state, msg }) as unknown as NonNullable<Terminal["status"]>;

const space = (tabPanes: readonly (readonly string[])[], tabNames: readonly string[]): ListedSpace => ({
  id: "space:local/spc-web",
  name: "website",
  tabs: tabPanes.length,
  addresses: tabPanes.flat(),
  tabPanes,
  tabNames,
  dir: "/work/website",
});

const shown = (rows: ReturnType<typeof switchTabRows>) => rows.map((row) => [row.shown.address, row.name, row.closes]);

describe("the switch sheet's rows", () => {
  test("twins are found by the pane each row shows, so a split tab showing a second claude says which tab", () => {
    // Tab 1 shows claude; unnamed tab 2 is split into codex and claude and is showing its claude pane.
    const sheet = space([["a"], ["b1", "b2"]], ["", ""]);
    const panes = [
      terminal("a", { name: "claude" }),
      terminal("b1", { name: "codex" }),
      terminal("b2", { name: "claude" }),
    ];
    expect(shown(switchTabRows(sheet, panes, "b2", false))).toEqual([
      ["a", "claude", "claude, tab 1"],
      ["b2", "claude", "claude, tab 2"],
    ]);
    // Showing its codex pane instead, tab 2 no longer reads like tab 1: each Close says only its name.
    expect(shown(switchTabRows(sheet, panes, "a", false))).toEqual([
      ["a", "claude", "claude"],
      ["b1", "codex", "codex"],
    ]);
  });

  test("with Needs you, a row is the pane that waits on the person, and twins are counted among the rows shown", () => {
    const sheet = space([["a"], ["b1", "b2"], ["c"]], ["", "", ""]);
    const panes = [
      terminal("a", { name: "claude", status: said("blocked", "Allow?") }),
      terminal("b1", { name: "codex" }),
      terminal("b2", { name: "claude", status: said("blocked", "Allow?") }),
      terminal("c", { name: "claude" }),
    ];
    expect(shown(switchTabRows(sheet, panes, "c", true))).toEqual([
      ["a", "claude", "claude, tab 1"],
      ["b2", "claude", "claude, tab 2"],
    ]);
  });
});

describe("a space screen's rows", () => {
  test("an unnamed tab reads its terminal's name and what it said, never its place; a named one says which terminal", () => {
    const rows = spaceTabRows(
      space([["t1"], ["t2"]], ["", "notes"]),
      [
        terminal("t1", { name: "deploy", status: said("blocked", "Approve the production deploy") }),
        terminal("t2", { name: "shell" }),
      ],
      0,
    );
    expect(rows.map((row) => [row.id, row.name, row.detail, row.status])).toEqual([
      ["t1", "deploy", "Approve the production deploy", "blocked"],
      ["t2", "notes", "shell", "idle"],
    ]);
  });

  test("a tab with no live terminal is left out, and a split tab is one row that opens its most urgent pane", () => {
    const rows = spaceTabRows(
      space([["t1"], ["t2", "t3"]], ["", ""]),
      [
        terminal("t1", { state: "ended" }),
        terminal("t2", { name: "build", status: said("working", "compiling") }),
        terminal("t3", { name: "review", status: said("blocked", "Allow edit?") }),
      ],
      0,
    );
    expect(rows.map((row) => [row.id, row.name, row.detail, row.status])).toEqual([
      ["t3", "review", "2 panes", "blocked"],
    ]);
  });

  test("a row on another machine leaves the machine to the screen's title", () => {
    const rows = spaceTabRows(space([["box/t1"]], [""]), [terminal("box/t1", { name: "plan" })], 0);
    expect(rows[0]?.machine).toBeUndefined();
  });
});

describe("a space screen's subtitle", () => {
  test("says where it runs, its running tabs and how many need the person", () => {
    const blocked = { id: "a", name: "deploy", status: "blocked" } as const;
    const done = { id: "b", name: "tests", status: "done" } as const;
    expect(spaceSummary("studio", [blocked, done])).toBe("studio · 2 tabs · 1 needs you");
    expect(spaceSummary("studio", [done])).toBe("studio · 1 tab");
    expect(spaceSummary("studio", [blocked, { ...blocked, id: "c" }])).toBe("studio · 2 tabs · 2 need you");
    expect(spaceSummary("build-box", [])).toBe("build-box · no running tabs");
  });
});
