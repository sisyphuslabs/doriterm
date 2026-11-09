import type { Terminal } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import type { ListedSpace } from "./model.ts";
import { nextAfterClosing, spaceSummary, spaceTabRows } from "./phone-space-rows.ts";

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

describe("where a phone goes when its open tab closes (#1478)", () => {
  const tabs = [["t1"], ["t2", "t3"], ["t4"]];

  test("the tab that slides into its place, at its first pane", () => {
    expect(nextAfterClosing(tabs, ["t1"])).toBe("t2");
    expect(nextAfterClosing(tabs, ["t2", "t3"])).toBe("t4");
  });

  test("the space's last tab when the closed one was last", () => {
    expect(nextAfterClosing(tabs, ["t4"])).toBe("t2");
  });

  test("a split tab whose shown pane has finished is still found by a live sibling", () => {
    // The phone showed t2, which ended; the tab is listed under t3, and closing it still moves on to t4.
    expect(nextAfterClosing([["t1"], ["t3"], ["t4"]], ["t2", "t3"])).toBe("t4");
  });

  test("nowhere when it was the only tab, or in none of them", () => {
    expect(nextAfterClosing([["t1"]], ["t1"])).toBeNull();
    expect(nextAfterClosing(tabs, ["t9"])).toBeNull();
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
