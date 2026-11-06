import { normalizeTrigger, type Platform } from "./trigger.ts";

export type Keymap = ReadonlyMap<string, string>;

const digits = (prefix: string, action: string): [string, string][] =>
  Array.from({ length: 9 }, (_, index) => [`${prefix}${index + 1}`, `${action}:${index + 1}`]);

/**
 * herdr-app's keys.macos.json merged with Ghostty's macOS defaults. Where the two disagree herdr-app wins and Ghostty's
 * trigger is added as an alias when it is free, except for panes, where Ghostty's are taken: ⌘W closes the focused pane
 * (the last one closes its tab) and ⌘⌥W the tab, so a split never loses every pane to one key. DESIGN.md lists each.
 */
const MAC: readonly [string, string][] = [
  ["super+t", "tab.new"],
  ["super+alt+w", "tab.close"],
  ["ctrl+tab", "tab.next"],
  ["ctrl+shift+tab", "tab.prev"],
  ["super+shift+]", "tab.next"],
  ["super+shift+[", "tab.prev"],
  ["super+shift+left", "tab.move:left"],
  ["super+shift+right", "tab.move:right"],
  ...digits("super+", "tab.select"),
  // herdr-app's space keys: Ctrl+1-9 select a space (Cmd+1-9 are its tabs), and Cmd+Alt+[ / ] cycle them.
  ...digits("ctrl+", "space.select"),
  ["super+alt+[", "space.prev"],
  ["super+alt+]", "space.next"],
  ["super+d", "pane.split:right"],
  ["super+shift+d", "pane.split:down"],
  ["super+w", "pane.close"],
  ["super+alt+left", "pane.go:left"],
  ["super+alt+right", "pane.go:right"],
  ["super+alt+up", "pane.go:up"],
  ["super+alt+down", "pane.go:down"],
  ["super+alt+shift+left", "pane.swap:left"],
  ["super+alt+shift+right", "pane.swap:right"],
  ["super+alt+shift+up", "pane.swap:up"],
  ["super+alt+shift+down", "pane.swap:down"],
  ["super+ctrl+left", "pane.resize:left"],
  ["super+ctrl+right", "pane.resize:right"],
  ["super+ctrl+up", "pane.resize:up"],
  ["super+ctrl+down", "pane.resize:down"],
  ["super+ctrl+=", "pane.equalize"],
  ["super+shift+enter", "pane.zoom"],
  ["super+]", "agent.next"],
  ["super+[", "agent.prev"],
  ["super+b", "layout.toggle:sidebar"],
  ["super+shift+.", "layout.focus:sidebar"],
  // Ghostty takes Cmd+Shift+F for its own search, so the filter takes Cmd+Alt+F.
  ["super+alt+f", "layout.filter:sidebar"],
  ["f2", "tab.rename"],
  ["shift+f2", "space.rename"],
  ["super+shift+p", "app.palette"],
  ["super+,", "app.settings"],
  ["super+=", "app.zoom_in"],
  ["super+shift+=", "app.zoom_in"],
  ["super+-", "app.zoom_out"],
  ["super+0", "app.zoom_reset"],
  ["super+c", "terminal.copy"],
  ["super+v", "terminal.paste"],
  ["super+a", "terminal.select_all"],
  ["super+k", "terminal.clear"],
  ["super+home", "terminal.scroll:top"],
  ["super+end", "terminal.scroll:bottom"],
  ["super+page_up", "terminal.scroll:page_up"],
  ["super+page_down", "terminal.scroll:page_down"],
  ["super+up", "terminal.prompt:prev"],
  ["super+down", "terminal.prompt:next"],
  ["alt+left", "send:\u001bb"],
  ["alt+right", "send:\u001bf"],
  ["alt+backspace", "send:\u0017"],
  ["super+left", "send:\u0001"],
  ["super+right", "send:\u0005"],
  ["super+backspace", "send:\u0015"],
];

/**
 * herdr-app's keys.json merged with Ghostty's Linux and Windows defaults. Panes move with Ctrl+Alt+arrows, Ghostty's
 * keys, instead of herdr-app's Alt+arrows and Alt+H/J/K/L, which shells and editors use for word moves and Meta keys.
 */
const OTHER: readonly [string, string][] = [
  ["ctrl+shift+t", "tab.new"],
  ["ctrl+shift+w", "tab.close"],
  ["ctrl+tab", "tab.next"],
  ["ctrl+shift+tab", "tab.prev"],
  ["ctrl+page_down", "tab.next"],
  ["ctrl+page_up", "tab.prev"],
  ["alt+]", "tab.next"],
  ["alt+[", "tab.prev"],
  // Ghostty's own move_tab; its ctrl+shift+left/right are previous/next tab, which doriface leaves alone.
  ["ctrl+shift+page_up", "tab.move:left"],
  ["ctrl+shift+page_down", "tab.move:right"],
  ...digits("alt+", "tab.select"),
  // herdr-app's space keys: Ctrl+1-9 select a space (Alt+1-9 are its tabs), and Ctrl+Alt+[ / ] cycle them.
  ...digits("ctrl+", "space.select"),
  ["ctrl+alt+[", "space.prev"],
  ["ctrl+alt+]", "space.next"],
  ["ctrl+shift+o", "pane.split:right"],
  ["ctrl+shift+e", "pane.split:down"],
  ["ctrl+shift+x", "pane.close"],
  ["ctrl+alt+left", "pane.go:left"],
  ["ctrl+alt+right", "pane.go:right"],
  ["ctrl+alt+up", "pane.go:up"],
  ["ctrl+alt+down", "pane.go:down"],
  ["ctrl+alt+shift+left", "pane.resize:left"],
  ["ctrl+alt+shift+right", "pane.resize:right"],
  ["ctrl+alt+shift+up", "pane.resize:up"],
  ["ctrl+alt+shift+down", "pane.resize:down"],
  ["ctrl+alt+=", "pane.equalize"],
  ["ctrl+shift+enter", "pane.zoom"],
  ["ctrl+shift+z", "pane.zoom"],
  ["alt+down", "agent.next"],
  ["alt+up", "agent.prev"],
  ["ctrl+shift+b", "layout.toggle:sidebar"],
  ["ctrl+shift+.", "layout.focus:sidebar"],
  // Ghostty takes Ctrl+Shift+F for its own search here, so the filter takes Ctrl+Alt+F.
  ["ctrl+alt+f", "layout.filter:sidebar"],
  ["f2", "tab.rename"],
  ["shift+f2", "space.rename"],
  ["ctrl+shift+p", "app.palette"],
  ["ctrl+,", "app.settings"],
  ["ctrl+=", "app.zoom_in"],
  ["ctrl+shift+=", "app.zoom_in"],
  ["ctrl+-", "app.zoom_out"],
  ["ctrl+0", "app.zoom_reset"],
  ["ctrl+shift+c", "terminal.copy"],
  ["ctrl+insert", "terminal.copy"],
  ["ctrl+shift+v", "terminal.paste"],
  ["shift+insert", "terminal.paste"],
  ["ctrl+shift+a", "terminal.select_all"],
  ["shift+home", "terminal.scroll:top"],
  ["shift+end", "terminal.scroll:bottom"],
  ["shift+page_up", "terminal.scroll:page_up"],
  ["shift+page_down", "terminal.scroll:page_down"],
  ["ctrl+shift+up", "terminal.prompt:prev"],
  ["ctrl+shift+down", "terminal.prompt:next"],
  ["ctrl+backspace", "send:\u0017"],
  ["ctrl+left", "send:\u001bb"],
  ["ctrl+right", "send:\u001bf"],
];

function keymap(entries: readonly [string, string][]): Keymap {
  const map = new Map<string, string>();
  for (const [trigger, action] of entries) {
    const normalized = normalizeTrigger(trigger);
    if (normalized === null) throw new Error(`default trigger is not a trigger: ${trigger}`);
    map.set(normalized, action);
  }
  return map;
}

const DEFAULTS: Readonly<Record<Platform, Keymap>> = { mac: keymap(MAC), other: keymap(OTHER) };

export function defaultKeymap(platform: Platform): Keymap {
  return DEFAULTS[platform];
}
