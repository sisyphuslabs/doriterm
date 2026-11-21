// The chord the app binds to an action on the platform the page runs as (#862): Meta for super on macOS, Control for
// ctrl elsewhere, read from the app's own default keymap so a spec presses what a person on that platform would.
import { type Page, test } from "@playwright/test";
import { defaultKeymap } from "../src/keys/defaults.ts";
import type { Platform } from "../src/keys/trigger.ts";

/** The platform the page's keymap is for, by the app's own test (currentPlatform, src/keys/trigger.ts). */
export const pagePlatform = (page: Page): Promise<Platform> =>
  page.evaluate(() => (/mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent) ? "mac" : "other"));

/** Every trigger bound to `action` by default on `platform`, in the keymap's order. */
export function triggersFor(platform: Platform, action: string): string[] {
  const found = [...defaultKeymap(platform)].filter(([, bound]) => bound === action).map(([trigger]) => trigger);
  if (found.length === 0) throw new Error(`nothing is bound to ${action} on ${platform}`);
  return found;
}

const MODIFIERS: Readonly<Record<string, { readonly key: string; readonly bit: number }>> = {
  alt: { key: "Alt", bit: 1 },
  ctrl: { key: "Control", bit: 2 },
  super: { key: "Meta", bit: 4 },
  shift: { key: "Shift", bit: 8 },
};

/** Triggers name keys by KeyboardEvent.code (layout independent); these are the codes of the named and symbol keys. */
const CODES: Readonly<Record<string, string>> = {
  "=": "Equal",
  "-": "Minus",
  "[": "BracketLeft",
  "]": "BracketRight",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  ";": "Semicolon",
  "'": "Quote",
  "`": "Backquote",
  "\\": "Backslash",
  space: "Space",
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  page_up: "PageUp",
  page_down: "PageDown",
  enter: "Enter",
  tab: "Tab",
  escape: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
};

function codeOf(key: string): string {
  if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (/^f\d{1,2}$/.test(key)) return key.toUpperCase();
  const code = CODES[key];
  if (code === undefined) throw new Error(`no key code for ${key}`);
  return code;
}

function parts(trigger: string): { readonly mods: readonly string[]; readonly key: string } {
  const split = trigger.split("+");
  const key = split.at(-1) === "" ? "+" : (split.at(-1) ?? "");
  return { mods: split.slice(0, split.at(-1) === "" ? -2 : -1), key };
}

/** A trigger ("super+alt+]") in Playwright's syntax, its modifiers by Playwright's names and its key by code (BracketRight). */
export function chordOf(trigger: string): string {
  const { mods, key } = parts(trigger);
  return [...mods.map((mod) => MODIFIERS[mod]?.key ?? mod), codeOf(key)].join("+");
}

/** The first chord the app binds to `action` on `platform`, in Playwright's syntax: for a spec that sets the platform. */
export function chordFor(platform: Platform, action: string): string {
  return chordOf(triggersFor(platform, action)[0] ?? "");
}

/** The chord bound to `action` on `platform` whose trigger `pick` selects: for a spec about one binding among several. */
export function chordWhere(platform: Platform, action: string, pick: (trigger: string) => boolean): string {
  const trigger = triggersFor(platform, action).find(pick);
  if (trigger === undefined) throw new Error(`no binding of ${action} on ${platform} matches`);
  return chordOf(trigger);
}

/**
 * Ghostty's focus chord for `move`: Cmd+Alt+arrow on macOS, Ctrl+Alt+arrow elsewhere. Off macOS herdr-app's Alt+arrow
 * and Alt+H/J/K/L are bound to the same actions first, so the first chord would not press Ghostty's (#1309).
 */
export function focusChord(platform: Platform, move: "left" | "right" | "up" | "down"): string {
  // The keymap names modifiers in its own order (alt+super+up), so the trigger is matched by its set of parts.
  const want = [platform === "mac" ? "super" : "ctrl", "alt", move].toSorted().join("+");
  return chordWhere(platform, `pane.go:${move}`, (trigger) => trigger.split("+").toSorted().join("+") === want);
}

/** The first chord the app binds to `action` on the page's platform, in Playwright's syntax. */
export async function shortcut(page: Page, action: string): Promise<string> {
  return chordFor(await pagePlatform(page), action);
}

/**
 * The modifier a person holds on the page's platform for a key the app binds to no action (select all in a field, a
 * paste, Cmd/Ctrl+Enter in the voice strip), as a trigger's: super (Cmd) on a Mac, ctrl elsewhere.
 */
export const commandModifier = async (page: Page): Promise<"super" | "ctrl"> =>
  (await pagePlatform(page)) === "mac" ? "super" : "ctrl";

/** Presses the chord that runs `action` on the page's platform. */
export async function pressShortcut(page: Page, action: string): Promise<void> {
  await page.keyboard.press(await shortcut(page, action));
}

/**
 * Presses `trigger` as the browser delivers it, a keydown carrying its own editing command (`paste`), which runs unless
 * the page cancels the keydown. Playwright's keyboard.press sends no editing command in Chromium on Linux (#510), so
 * in Chromium the keydown goes through CDP with the command named. CDP exists only in Chromium (#1909). Outside it a
 * pressed chord runs the editing command the HOST binds to it, so it is pressed only when its modifier is the host's own
 * (Cmd on a Mac host, Ctrl elsewhere); a page run as another platform there (E2E_PAGE_PLATFORM=mac on Linux) would
 * press a chord that runs nothing, so the test is skipped with that reason rather than pass a step that did not happen.
 */
export async function pressWithCommand(page: Page, trigger: string, command: string): Promise<void> {
  // The project's browser, as its device names it (Desktop Chrome sets defaultBrowserType, not browserName); a persistent
  // context has no browser() to ask.
  const { browserName, defaultBrowserType } = test.info().project.use;
  const browser = browserName ?? defaultBrowserType ?? "chromium";
  if (browser !== "chromium") {
    const hostModifier = process.platform === "darwin" ? "super" : "ctrl";
    test.skip(
      !parts(trigger).mods.includes(hostModifier),
      `${trigger} runs no ${command} in ${browser} on this host: only CDP names the command, and CDP is Chromium's`,
    );
    await page.keyboard.press(chordOf(trigger));
    return;
  }
  const { mods, key } = parts(trigger);
  const code = codeOf(key);
  const modifiers = mods.reduce((bits, mod) => bits | (MODIFIERS[mod]?.bit ?? 0), 0);
  const letter = /^[a-z]$/.test(key);
  const named = letter ? key.toUpperCase() : code;
  const keyCode = letter ? key.toUpperCase().charCodeAt(0) : key === "insert" ? 45 : 0;
  const cdp = await page.context().newCDPSession(page);
  const event = { modifiers, key: named, code, windowsVirtualKeyCode: keyCode };
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...event, commands: [command] });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
  await cdp.detach();
}
