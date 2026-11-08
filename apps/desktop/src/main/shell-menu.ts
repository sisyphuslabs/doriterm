import type { MenuItemConstructorOptions } from "electron";
import type { DesktopPlatform } from "../shared/bridge.ts";

/** The page's actions the Shell menu lists, in its order; a null entry is a separator, a list a submenu. */
const ITEMS: readonly (readonly [string, string] | null | readonly [string, readonly (readonly [string, string])[]])[] =
  [
    ["tab.new", "New Tab"],
    ["tab.rename", "Rename Tab…"],
    null,
    ["pane.split:right", "Split Right"],
    ["pane.split:down", "Split Down"],
    null,
    [
      "Select Pane",
      [
        ["pane.go:left", "Left"],
        ["pane.go:right", "Right"],
        ["pane.go:up", "Up"],
        ["pane.go:down", "Down"],
      ],
    ],
    [
      "Swap Pane",
      [
        ["pane.swap:left", "Left"],
        ["pane.swap:right", "Right"],
        ["pane.swap:up", "Up"],
        ["pane.swap:down", "Down"],
      ],
    ],
    [
      "Resize Pane",
      [
        ["pane.resize:left", "Move Edge Left"],
        ["pane.resize:right", "Move Edge Right"],
        ["pane.resize:up", "Move Edge Up"],
        ["pane.resize:down", "Move Edge Down"],
      ],
    ],
    ["pane.equalize", "Equalize Panes"],
    ["pane.zoom", "Zoom Pane"],
    null,
    ["pane.close", "Close Pane"],
    ["tab.close", "Close Tab"],
    null,
    ["Select Space", Array.from({ length: 9 }, (_, index) => [`space.select:${index + 1}`, `${index + 1}`] as const)],
    ["space.prev", "Previous Space"],
    ["space.next", "Next Space"],
    ["space.new", "New Space"],
  ];

export const SHELL_MENU_ACTIONS: ReadonlySet<string> = new Set(
  ITEMS.flatMap((item) => (item === null ? [] : typeof item[1] === "string" ? [item[0]] : item[1].map(([id]) => id))),
);

const KEYS: Readonly<Record<string, string>> = {
  left: "Left",
  right: "Right",
  up: "Up",
  down: "Down",
  enter: "Return",
  tab: "Tab",
  escape: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  page_up: "PageUp",
  page_down: "PageDown",
  space: "Space",
};

/**
 * A trigger in the page's Ghostty syntax (`super+shift+d`) as an Electron accelerator (`Command+Shift+D`), or
 * undefined when Electron has no name for its key. The menu only shows it: the page's keymap handles the key.
 */
export function acceleratorOf(trigger: string, platform: DesktopPlatform): string | undefined {
  const parts = trigger.split("+");
  const key = parts.at(-1) ?? "";
  const mods = parts.slice(0, -1).map((mod) => {
    if (mod === "super") return platform === "darwin" ? "Command" : "Super";
    if (mod === "ctrl") return "Ctrl";
    if (mod === "alt") return platform === "darwin" ? "Option" : "Alt";
    return mod === "shift" ? "Shift" : undefined;
  });
  const name = KEYS[key] ?? (/^(?:[a-z0-9]|f\d{1,2}|[=\-[\];',./`\\])$/.test(key) ? key.toUpperCase() : undefined);
  if (name === undefined || mods.some((mod) => mod === undefined)) return undefined;
  return [...mods, name].join("+");
}

/** The Shell menu: what the page can do with tabs and panes, each item showing its current shortcut. */
export function shellMenu(
  platform: DesktopPlatform,
  keys: ReadonlyMap<string, string>,
  run: (action: string) => void,
): MenuItemConstructorOptions {
  const item = ([id, label]: readonly [string, string]): MenuItemConstructorOptions => {
    const trigger = keys.get(id);
    const accelerator = trigger === undefined ? undefined : acceleratorOf(trigger, platform);
    return accelerator === undefined
      ? { label, click: () => run(id) }
      : { label, accelerator, registerAccelerator: false, click: () => run(id) };
  };
  return {
    label: "Shell",
    submenu: ITEMS.map((entry): MenuItemConstructorOptions => {
      if (entry === null) return { type: "separator" };
      const [label, rest] = entry;
      return typeof rest === "string" ? item([label, rest]) : { label, submenu: rest.map(item) };
    }),
  };
}
