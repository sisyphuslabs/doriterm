import { normalizeTrigger, type Platform } from "./trigger.ts";

export type Keymap = ReadonlyMap<string, string>;

const digits = (prefix: string, action: string): [string, string][] =>
  Array.from({ length: 9 }, (_, index) => [`${prefix}${index + 1}`, `${action}:${index + 1}`]);

/**
 * herdr-app's keys.macos.json merged with Ghostty's macOS defaults. Where the two disagree herdr-app wins and Ghostty's
 * trigger is added as an alias when it is free: ⌘W closes the tab and ⌘⇧W the focused pane, as in herdr-app, and
 * Ghostty's ⌘⌥W closes the tab too. herdr-app-parity.ts records every herdr-app default doriface binds differently.
 */
const MAC: readonly [string, string][] = [
  ["super+t", "tab.new"],
  ["super+w", "tab.close"],
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
  ["super+n", "space.new"],
  ["super+d", "pane.split:right"],
  ["super+shift+d", "pane.split:down"],
  ["super+shift+w", "pane.close"],
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
  // doriface's own rename chord (#702); in a browser tab it is hard reload, which Chrome, Edge and Firefox let a page take.
  ["super+shift+r", "tab.rename"],
  ["shift+f2", "space.rename"],
  ["super+shift+p", "app.palette"],
  ["super+,", "app.settings"],
  ["super+/", "app.help"],
  ["super+shift+/", "app.help"],
  ["super+=", "app.zoom_in"],
  ["super+shift+=", "app.zoom_in"],
  ["super+-", "app.zoom_out"],
  ["super+0", "app.zoom_reset"],
  ["super+c", "terminal.copy"],
  ["super+v", "terminal.paste"],
  ["super+a", "terminal.select_all"],
  ["super+k", "terminal.clear"],
  ["super+f", "terminal.search"],
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
 * herdr-app's keys.json merged with Ghostty's Linux and Windows defaults. Focus moves with herdr-app's Alt+arrows and
 * Alt+H/J/K/L and Ghostty's Ctrl+Alt+arrows; with no pane that way the key reaches the terminal program.
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
  // herdr-app cycles spaces with Ghostty's move_tab chord (Ctrl+Shift+PgUp/PgDn), so a tab moves with Ctrl+Alt+Shift.
  ["ctrl+alt+shift+page_up", "tab.move:left"],
  ["ctrl+alt+shift+page_down", "tab.move:right"],
  // herdr-app's number keys here: Ctrl+1-9 select a tab and Alt+1-9 a space.
  ...digits("ctrl+", "tab.select"),
  ...digits("alt+", "space.select"),
  ["ctrl+shift+page_up", "space.prev"],
  ["ctrl+shift+page_down", "space.next"],
  ["ctrl+alt+[", "space.prev"],
  ["ctrl+alt+]", "space.next"],
  ["ctrl+shift+n", "space.new"],
  ["ctrl+shift+o", "pane.split:right"],
  ["ctrl+shift+e", "pane.split:down"],
  ["ctrl+shift+x", "pane.close"],
  ["alt+h", "pane.go:left"],
  ["alt+j", "pane.go:down"],
  ["alt+k", "pane.go:up"],
  ["alt+l", "pane.go:right"],
  ["ctrl+alt+left", "pane.go:left"],
  ["ctrl+alt+right", "pane.go:right"],
  ["ctrl+alt+up", "pane.go:up"],
  ["ctrl+alt+down", "pane.go:down"],
  ["alt+shift+h", "pane.swap:left"],
  ["alt+shift+j", "pane.swap:down"],
  ["alt+shift+k", "pane.swap:up"],
  ["alt+shift+l", "pane.swap:right"],
  ["ctrl+alt+shift+left", "pane.resize:left"],
  ["ctrl+alt+shift+right", "pane.resize:right"],
  ["ctrl+alt+shift+up", "pane.resize:up"],
  ["ctrl+alt+shift+down", "pane.resize:down"],
  ["ctrl+alt+=", "pane.equalize"],
  ["ctrl+shift+enter", "pane.zoom"],
  ["ctrl+shift+z", "pane.zoom"],
  // Alt+Up and Alt+Down are the answer keys agents and editors read (ESC [ 1 ; 3 A/B), and a Windows or Linux
  // terminal is where they are pressed, so Doriterm keeps its hands off them: agent navigation mirrors the
  // macOS pair as Ctrl+Shift+] and Ctrl+Shift+[, since a bare Ctrl+[ is ESC to every terminal.
  ["ctrl+shift+]", "agent.next"],
  ["ctrl+shift+[", "agent.prev"],
  ["ctrl+shift+b", "layout.toggle:sidebar"],
  ["ctrl+shift+.", "layout.focus:sidebar"],
  // Ghostty takes Ctrl+Shift+F for its own search here, so the filter takes Ctrl+Alt+F.
  ["ctrl+alt+f", "layout.filter:sidebar"],
  ["f2", "tab.rename"],
  ["ctrl+shift+r", "tab.rename"],
  ["shift+f2", "space.rename"],
  ["ctrl+shift+p", "app.palette"],
  ["ctrl+,", "app.settings"],
  // herdr-app's Ctrl+? (Ctrl+Shift+/). Some terminals send DEL for it, which Backspace already sends, so no program
  // loses a key it needs.
  ["ctrl+shift+/", "app.help"],
  ["ctrl+=", "app.zoom_in"],
  ["ctrl+shift+=", "app.zoom_in"],
  ["ctrl+-", "app.zoom_out"],
  ["ctrl+0", "app.zoom_reset"],
  ["ctrl+shift+c", "terminal.copy"],
  ["ctrl+insert", "terminal.copy"],
  ["ctrl+shift+v", "terminal.paste"],
  ["shift+insert", "terminal.paste"],
  ["ctrl+shift+a", "terminal.select_all"],
  ["ctrl+shift+f", "terminal.search"],
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
