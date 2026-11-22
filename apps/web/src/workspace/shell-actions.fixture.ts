import type { Terminal } from "@doriface/protocol";
import type { LayoutTab } from "./layout-model.ts";
import type { Layout } from "./use-layout.ts";

/** The shell-action tests' world: one tab with one pane on t1, and the spaces the space keys count. */
export const terminal = (address: string): Terminal => ({
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
export const noop = (): void => undefined;
/** The spaces the space keys count, in the order the sidebar lists them, and where selecting one goes. */
export const spaces = (calls: string[] = []) => ({
  spaceKeys: ["space:spc1", "space:spc2", "space:spc3"] as const,
  onSelectSpace: (key: string) => calls.push(key),
});
export const pane = { id: "p1", address: "t1", mod: null };
export const tab: LayoutTab = {
  key: "tb1",
  id: "tb1",
  space: "spc1",
  spaceKey: "space:spc1",
  machine: null,
  name: "",
  root: { children: [{ content: { terminal: "t1" }, id: "p1", type: "block" }], id: "tb1", type: "row" },
  panes: [pane],
  readOnly: null,
  pinned: false,
  transient: false,
};
export const layout: Layout = {
  tabs: [tab],
  shown: [tab],
  selectSpace: noop,
  active: tab,
  focused: pane,
  zoomed: null,
  selectTab: noop,
  focusPane: noop,
  openTerminal: noop,
  placeTerminal: noop,
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
  pinTab: () => Promise.resolve(),
  closeSetOf: () => [],
  restored: true,
  lastMove: null,
};
