import type { Terminal } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import { actionFor } from "../keys/actions.ts";
import { availableActions, type Shell } from "./shell-actions.ts";
import { desktopActions, phoneActions } from "./use-app-actions.ts";
import type { LayoutTab } from "./layout-model.ts";
import type { Layout } from "./use-layout.ts";

const terminal = (address: string): Terminal => ({
  address,
  argv: ["sh"],
  cols: 80,
  rows: 24,
  created_ms: 0,
  cwd: "/work",
  labels: {},
  screen: "exact",
  state: "live",
});
const noop = (): void => undefined;
/** The spaces the space keys count, in the order the sidebar lists them, and where selecting one goes. */
const spaces = (calls: string[] = []) => ({
  spaceKeys: ["space:spc1", "space:spc2", "space:spc3"] as const,
  onSelectSpace: (key: string) => calls.push(key),
});
const pane = { id: "p1", address: "t1", mod: null };
const tab: LayoutTab = {
  key: "tb1",
  id: "tb1",
  space: "spc1",
  spaceKey: "space:spc1",
  machine: null,
  name: "",
  root: { children: [{ content: { terminal: "t1" }, id: "p1", type: "block" }], id: "tb1", type: "row" },
  panes: [pane],
  readOnly: null,
  transient: false,
};
const layout: Layout = {
  tabs: [tab],
  shown: [tab],
  selectSpace: noop,
  active: tab,
  focused: pane,
  zoomed: null,
  selectTab: noop,
  focusPane: noop,
  openTerminal: noop,
  split: noop,
  dropPane: noop,
  closeTab: noop,
  go: () => false,
  bumped: null,
  fresh: null,
  claimed: null,
  seen: {},
  remember: noop,
  resize: () => Promise.resolve(true),
  resizeFocused: () => false,
  equalize: () => true,
  toggleZoom: () => true,
  move: () => Promise.resolve(false),
  swap: () => true,
  moveTab: noop,
  renameTab: () => Promise.resolve(),
  restored: true,
  lastMove: null,
};
const handlers = {
  desktop: desktopActions(
    {
      terminals: [terminal("t1"), terminal("t2")],
      layout,
      ...spaces(),
      onNew: noop,
      onNewSpace: noop,
      onSplit: noop,
      onCloseTab: noop,
      onClosePane: noop,
      onRenameTab: noop,
      onToggleSidebar: noop,
      onFocusSidebar: noop,
      onFilterSidebar: noop,
      onSession: () => true,
      onDictate: () => true,
    },
    noop,
  ),
  phone: phoneActions(
    noop,
    noop,
    () => true,
    () => true,
  ),
} satisfies Record<Shell, (action: string) => boolean>;

describe("every palette row runs something", () => {
  test.each(["desktop", "phone"] as const)("%s: its handler takes every app action its palette lists", (shell) => {
    const unhandled = availableActions(shell, true)
      .map((action) => action.id)
      .filter((id) => actionFor(id)?.scope === "app" && !handlers[shell](id));
    expect(unhandled).toEqual([]);
  });

  test.each(["desktop", "phone"] as const)(
    "%s: every other row is a terminal action, which the focused terminal takes",
    (shell) => {
      const others = availableActions(shell, true)
        .map((action) => action.id)
        .filter((id) => actionFor(id)?.scope !== "app");
      expect(others).toEqual(["terminal.search"]);
    },
  );
});

const sessionRows = (shell: Shell, inView: boolean) =>
  availableActions(shell, inView).filter(({ id }) => id.startsWith("session."));

const moves = (active: string) =>
  availableActions("desktop", true, null, { keys: ["t1", "t2"], active })
    .map(({ id }) => id)
    .filter((id) => id.startsWith("tab.move:"));

const stripTab = (key: string): LayoutTab => ({
  key,
  id: key,
  space: "s",
  spaceKey: "space:s",
  machine: null,
  name: "",
  root: { children: [], id: key, type: "row" },
  panes: [],
  readOnly: null,
  transient: false,
});

describe("moving a tab", () => {
  test("the palette offers only the moves the active tab can make", () => {
    expect(moves("t1")).toEqual(["tab.move:right"]);
    expect(moves("t2")).toEqual(["tab.move:left"]);
  });

  test("a key moves the focused tab, else the active one, one place, and leaves the key at an end", () => {
    const calls: [string, number][] = [];
    const handler = (focused: string | null) =>
      desktopActions(
        {
          terminals: [terminal("t1"), terminal("t2"), terminal("t3")],
          layout: {
            ...layout,
            tabs: ["t1", "t2", "t3"].map(stripTab),
            active: stripTab("t1"),
            moveTab: (key, to) => calls.push([key, to]),
          },
          ...spaces(),
          onNew: noop,
          onNewSpace: () => undefined,
          onSplit: noop,
          onCloseTab: noop,
          onClosePane: noop,
          onRenameTab: noop,
          onToggleSidebar: noop,
          onFocusSidebar: noop,
          onFilterSidebar: noop,
          onSession: () => true,
          onDictate: () => true,
          focusedTab: () => focused,
        },
        noop,
      );
    expect(handler(null)("tab.move:right")).toBe(true);
    expect(handler("t2")("tab.move:left")).toBe(true);
    expect(handler(null)("tab.move:left")).toBe(false);
    expect(handler("t3")("tab.move:right")).toBe(false);
    expect(calls).toEqual([
      ["t1", 1],
      ["t2", 0],
    ]);
  });
});

describe("session actions", () => {
  test.each(["desktop", "phone"] as const)(
    "%s: rename and end are listed, ready to run, with a session in view",
    (shell) => {
      expect(sessionRows(shell, true)).toEqual([{ id: "session.rename" }, { id: "session.end" }]);
    },
  );

  test.each(["desktop", "phone"] as const)("%s: with no session in view they are left out, not disabled", (shell) => {
    expect(sessionRows(shell, false)).toEqual([]);
  });
});

describe("space rename (#395)", () => {
  test.each(["desktop", "phone"] as const)(
    "%s: Rename space is a palette row with a session in view, and left out without",
    (shell) => {
      const rename = (inView: boolean) => availableActions(shell, inView).filter(({ id }) => id === "space.rename");
      expect(rename(true)).toEqual([{ id: "space.rename" }]);
      expect(rename(false)).toEqual([]);
    },
  );

  test("a layout that takes no edits lists Rename space as unavailable, with why (#404)", () => {
    const listed = availableActions("desktop", true, "the machine is not connected").find(
      ({ id }) => id === "space.rename",
    );
    expect(listed).toEqual({ id: "space.rename", unavailable: "the machine is not connected" });
  });
});

describe("dictation (#194)", () => {
  test.each(["desktop", "phone"] as const)(
    "%s: Dictate is a palette row with a session in view, and left out without",
    (shell) => {
      const dictate = (inView: boolean) => availableActions(shell, inView).filter(({ id }) => id === "voice.dictate");
      expect(dictate(true)).toEqual([{ id: "voice.dictate" }]);
      expect(dictate(false)).toEqual([]);
    },
  );

  test("the row and a bound key run the shell's dictation, and leave the key alone when it has none", () => {
    const runs: string[] = [];
    const desktop = (onDictate: () => boolean) =>
      desktopActions(
        {
          terminals: [],
          layout,
          ...spaces(),
          onNew: noop,
          onNewSpace: () => undefined,
          onSplit: noop,
          onCloseTab: noop,
          onClosePane: noop,
          onRenameTab: noop,
          onToggleSidebar: noop,
          onFocusSidebar: noop,
          onFilterSidebar: noop,
          onSession: () => true,
          onDictate,
        },
        noop,
      );
    expect(desktop(() => (runs.push("desktop"), true))("voice.dictate")).toBe(true);
    expect(desktop(() => false)("voice.dictate")).toBe(false);
    expect(
      phoneActions(
        noop,
        noop,
        () => true,
        () => (runs.push("phone"), true),
      )("voice.dictate"),
    ).toBe(true);
    expect(
      phoneActions(
        noop,
        noop,
        () => true,
        () => false,
      )("voice.dictate"),
    ).toBe(false);
    expect(runs).toEqual(["desktop", "phone"]);
  });
});

const spaceHandler = (spaceKeys: readonly string[], active: string | null, calls: string[]) =>
  desktopActions(
    {
      terminals: [],
      layout: active === null ? { ...layout, active: null } : { ...layout, active: { ...tab, spaceKey: active } },
      spaceKeys,
      onSelectSpace: (key) => calls.push(key),
      onNew: noop,
      onNewSpace: () => undefined,
      onSplit: noop,
      onCloseTab: noop,
      onClosePane: noop,
      onRenameTab: noop,
      onToggleSidebar: noop,
      onFocusSidebar: noop,
      onFilterSidebar: noop,
      onSession: () => true,
      onDictate: () => false,
    },
    noop,
  );

describe("space keys, as herdr-app binds them", () => {
  const three = ["space:s1", "space:s2", "space:s3"];

  test("a number chord shows that place in the sidebar, and one with no space there leaves the key alone", () => {
    const calls: string[] = [];
    const run = (action: string, active: string | null = "space:s1") => spaceHandler(three, active, calls)(action);
    expect(run("space.select:2")).toBe(true);
    expect(run("space.select:9")).toBe(false);
    expect(run("space.select:1")).toBe(false);
    expect(calls).toEqual(["space:s2"]);
  });

  test("next and previous step in sidebar order and wrap at either end", () => {
    const calls: string[] = [];
    const at = (active: string, action: string) => spaceHandler(three, active, calls)(action);
    expect(at("space:s3", "space.next")).toBe(true);
    expect(at("space:s1", "space.prev")).toBe(true);
    expect(at("space:s2", "space.next")).toBe(true);
    expect(at("space:s2", "space.prev")).toBe(true);
    expect(calls).toEqual(["space:s1", "space:s3", "space:s3", "space:s1"]);
  });

  test("with no space at all they are left to the terminal", () => {
    const calls: string[] = [];
    expect(spaceHandler([], null, calls)("space.select:1")).toBe(false);
    expect(spaceHandler([], null, calls)("space.next")).toBe(false);
    expect(spaceHandler([], null, calls)("space.prev")).toBe(false);
    expect(calls).toEqual([]);
  });
});
