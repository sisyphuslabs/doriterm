import type { Terminal } from "@doriface/protocol";
import { useNavigate } from "@tanstack/react-router";
import { terminalConfigStore } from "../ghostty/config-store.ts";
import { single, withValues, withoutKey, type TerminalConfig } from "../ghostty/config.ts";
import { KEY_BY_NAME } from "../ghostty/keys.ts";
import { actionChosen, useActionHandler, type ActionHandler } from "../keys/dispatcher.ts";
import { toggleShortcuts } from "../keys/shortcuts-store.ts";
import type { Direction } from "../layout/neighbor.ts";
import type { Axis } from "@doriface/protocol/layout";
import type { Layout, PaneTarget } from "./use-layout.ts";
import { nextNeedingYou } from "./attention.ts";

export interface AppActionTargets {
  readonly terminals: readonly Terminal[];
  readonly layout: Layout;
  readonly onNew: () => void;
  /** Starts a new space, as the New tab menu's New space does (herdr-app's `space.new`). */
  readonly onNewSpace: () => void;
  /** Starts a terminal beside the focused pane: to its right along a row, below it along a column. */
  readonly onSplit: (axis: Axis, target?: PaneTarget) => void;
  /** Closes a tab, asking first whether its sessions keep running. */
  readonly onCloseTab: (key: string) => void;
  /** Closes the focused pane, asking first whether its session keeps running. */
  readonly onClosePane: (address: string) => void;
  /** Asks for a new name for the tab, as herdr-app's `tab.rename` (F2). */
  readonly onRenameTab: (key: string) => void;
  readonly onToggleSidebar: () => void;
  /** Moves focus from the terminal to the sidebar, or back. */
  readonly onFocusSidebar: () => void;
  /** Shows the whole sidebar with its filter field out and focused. */
  readonly onFilterSidebar: () => void;
  /** Renames or ends the session in view, or renames its space; false when there is none. */
  readonly onSession: SessionVerb;
  /** Starts dictating into the session in view, or ends the dictation under way; false with no session in view. */
  readonly onDictate: () => boolean;
  /** The tab that has keyboard focus, which a key moves instead of the active one; none when focus is elsewhere. */
  readonly focusedTab?: () => string | null;
  /** Every space in the order the sidebar lists them (`spaceKey`s): what the space keys select and cycle through. */
  readonly spaceKeys: readonly string[];
  readonly onSelectSpace: (key: string) => void;
}

export type SessionVerb = (verb: "rename" | "end" | "rename-space") => boolean;

function sessionAction(action: string, onSession: SessionVerb): boolean {
  if (action === "session.rename") return onSession("rename");
  if (action === "session.end") return onSession("end");
  if (action === "space.rename") return onSession("rename-space");
  if (action === "app.help") return (toggleShortcuts(), true);
  return stepTerminalFont(action);
}

const FONT_STEP = 1;

/** Steps font-size within the schema's bounds; null resets it to the default. */
export function zoomedConfig(config: TerminalConfig, delta: number | null): TerminalConfig {
  if (delta === null) return withoutKey(config, "font-size");
  const kind = KEY_BY_NAME.get("font-size")?.kind;
  const [min, max] = kind?.type === "number" ? [kind.min, kind.max] : [1, 1000];
  const size = Math.min(max, Math.max(min, Number(single(config, "font-size")) + delta));
  return withValues(config, "font-size", [String(size)]);
}

/** The text-size actions and their steps; null resets the size to the default. */
const FONT_DELTA: Readonly<Record<string, number | null>> = {
  "app.zoom_in": FONT_STEP,
  "app.zoom_out": -FONT_STEP,
  "app.zoom_reset": null,
};

/**
 * Steps the terminal text size, as Ghostty and herdr-app do, in the desktop app and a browser alike; false for any other
 * action. The window is never zoomed, so the chrome beside the macOS window buttons keeps its size (#388).
 */
export function stepTerminalFont(action: string): boolean {
  const delta = FONT_DELTA[action];
  if (delta === undefined) return false;
  void terminalConfigStore.update((current) => zoomedConfig(current, delta));
  return true;
}

const isTextSize = (action: string): boolean => FONT_DELTA[action] !== undefined;

/**
 * Whether a text-size key here steps the saved terminal text size, rather than being left to the browser's own zoom.
 * The workspace and Settings take it through their app handler, since the terminals or Appearance's hint are on screen
 * (#859, #1162); the desktop window is never zoomed, so its fallback steps the text on every screen (#388).
 */
export const takesTextSizeKey = (desktop: boolean): boolean => desktop;

/** Whether selecting the address does anything: a null target or the active tab leaves the key unhandled. */
export function shouldSelect(address: string | null, active: string | null): boolean {
  return address !== null && address !== active;
}

export function neighbour(list: readonly string[], current: string | null, step: 1 | -1): string | null {
  if (list.length === 0) return null;
  const index = current === null ? -1 : list.indexOf(current);
  const target = list[(index + step + list.length) % list.length] ?? null;
  return target === current ? null : target;
}

/** The phone shell's app actions: new terminal, settings and terminal text size; it has no tabs, panes or sidebar. */
export function phoneActions(
  onNew: () => void,
  openSettings: () => void,
  onSession: SessionVerb,
  onDictate: () => boolean,
): ActionHandler {
  return (action) => {
    if (action === "tab.new") return (onNew(), true);
    if (action === "voice.dictate") return onDictate();
    if (action === "app.settings") return (openSettings(), true);
    // The size it steps is on this screen (#1162).
    if (FONT_DELTA[action] !== undefined) return stepTerminalFont(action);
    return sessionAction(action, onSession);
  };
}

export function usePhoneActions(onNew: () => void, onSession: SessionVerb, onDictate: () => boolean): void {
  const navigate = useNavigate();
  useActionHandler(
    "app",
    phoneActions(onNew, () => void navigate({ to: "/settings" }), onSession, onDictate),
  );
}

export function useAppActions(targets: AppActionTargets): void {
  const navigate = useNavigate();
  useActionHandler(
    "app",
    desktopActions(targets, () => void navigate({ to: "/settings" })),
  );
}

/** Moves a tab one place; at an end of the strip the key is left to the terminal, as with nothing to select. */
function moveTab(layout: Layout, key: string | null, side: string): boolean {
  const keys = layout.tabs.map((tab) => tab.key);
  const from = key === null ? -1 : keys.indexOf(key);
  const to = from + (side === "left" ? -1 : 1);
  if (key === null || from === -1 || to < 0 || to >= keys.length) return false;
  layout.moveTab(key, to);
  return true;
}

function selectTab(layout: Layout, key: string | null): boolean {
  // Nothing to do leaves the key to the terminal (ctrl+tab in a shell with one tab open).
  if (key === null || !shouldSelect(key, layout.active?.key ?? null)) return false;
  layout.selectTab(key);
  return true;
}

const isDirection = (value: string): value is Direction =>
  value === "left" || value === "right" || value === "up" || value === "down";

function openAgent(layout: Layout, address: string | null): boolean {
  if (address === null || !shouldSelect(address, layout.focused?.address ?? null)) return false;
  layout.placeTerminal(address);
  return true;
}

/** The space `step` places away in `spaceKeys`, wrapping at either end; null when there is nowhere to go. */
function steppedSpace(spaceKeys: readonly string[], active: string | null, step: 1 | -1): string | null {
  if (spaceKeys.length === 0) return null;
  const at = active === null ? -1 : spaceKeys.indexOf(active);
  if (at === -1) return spaceKeys[step === 1 ? 0 : spaceKeys.length - 1] ?? null;
  const key = spaceKeys[(at + step + spaceKeys.length) % spaceKeys.length] ?? null;
  return key === active ? null : key;
}

export function desktopActions(
  {
    terminals,
    layout,
    onNew,
    onNewSpace,
    onSplit,
    onCloseTab,
    onClosePane,
    onRenameTab,
    onToggleSidebar,
    onFocusSidebar,
    onFilterSidebar,
    onSession,
    onDictate,
    focusedTab,
    spaceKeys,
    onSelectSpace,
  }: AppActionTargets,
  openSettings: () => void,
): ActionHandler {
  return (action, programReceives = true) => {
    // An action chosen from the palette or the Shell menu is one the person asked for, so the size it steps is all
    // it needs; the browser keeps a key pressed on a screen that shows nothing (#1162).
    if (actionChosen() && isTextSize(action)) return stepTerminalFont(action);
    const live = terminals.filter((terminal) => terminal.state === "live").map((terminal) => terminal.address);
    // The tab bar's tabs: the selected space's (#404).
    const keys = layout.shown.map((tab) => tab.key);
    const active = layout.active?.key ?? null;
    const activeSpace = layout.active?.spaceKey ?? null;
    const focused = layout.focused?.address ?? null;
    const [verb, argument = ""] = action.split(":");
    // A space key shows a space the sidebar lists; no space there, or the one in view, leaves the key to the terminal.
    const selectSpace = (key: string | null): boolean => {
      if (key === null || key === activeSpace) return false;
      onSelectSpace(key);
      return true;
    };
    switch (verb) {
      case "tab.new":
        onNew();
        return true;
      case "tab.close":
        return active === null ? false : (onCloseTab(active), true);
      case "tab.next":
        return selectTab(layout, neighbour(keys, active, 1));
      case "tab.prev":
        return selectTab(layout, neighbour(keys, active, -1));
      case "tab.select":
        return selectTab(layout, keys[Number(argument) - 1] ?? null);
      case "tab.last":
        return selectTab(layout, keys.at(-1) ?? null);
      case "tab.rename":
        // A tab of no document has no name to keep: the key is left to the terminal.
        if (layout.active === null || layout.active.transient) return false;
        onRenameTab(layout.active.key);
        return true;
      case "tab.move":
        return moveTab(layout, focusedTab?.() ?? active, argument);
      case "space.select":
        return selectSpace(spaceKeys[Number(argument) - 1] ?? null);
      case "space.next":
        return selectSpace(steppedSpace(spaceKeys, activeSpace, 1));
      case "space.prev":
        return selectSpace(steppedSpace(spaceKeys, activeSpace, -1));
      case "space.new":
        onNewSpace();
        return true;
      case "pane.split":
        if (focused === null || (argument !== "right" && argument !== "down")) return false;
        onSplit(argument === "right" ? "row" : "column");
        return true;
      case "pane.go":
        return isDirection(argument) && layout.go(argument, programReceives);
      case "pane.swap":
        return isDirection(argument) && layout.swap(argument, programReceives);
      case "pane.resize":
        return isDirection(argument) && layout.resizeFocused(argument);
      case "pane.equalize":
        return layout.equalize();
      case "pane.zoom":
        return layout.toggleZoom();
      case "pane.close":
        return focused === null ? false : (onClosePane(focused), true);
      case "agent.next":
        return openAgent(layout, neighbour(live, focused, 1));
      case "agent.prev":
        return openAgent(layout, neighbour(live, focused, -1));
      case "agent.waiting":
        return openAgent(layout, nextNeedingYou(terminals, focused));
      case "layout.toggle":
        onToggleSidebar();
        return true;
      case "layout.focus":
        onFocusSidebar();
        return true;
      case "layout.filter":
        onFilterSidebar();
        return true;
      case "app.zoom_in":
      case "app.zoom_out":
      case "app.zoom_reset":
        return stepTerminalFont(action);
      case "app.settings":
        openSettings();
        return true;
      case "voice.dictate":
        return onDictate();
      default:
        return sessionAction(action, onSession);
    }
  };
}
