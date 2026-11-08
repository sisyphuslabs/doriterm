import type { Locator, Page } from "@playwright/test";
import { expect } from "./fixtures.ts";

/**
 * Starts, in the shell the terminal is running, a program that asks for every mouse movement (`?1003h`, SGR encoded)
 * and prints each byte it is sent as visible text (`cat -v`), the way a TUI that tracks the mouse would see them: a
 * press reaches it as `^[[<0;x;yM`, motion as `^[[<32;x;yM` or `^[[<35;x;yM`, a release as `^[[<0;x;ym`, where y is
 * the row counted from the top of the screen. The two lines printed first give a drag something to select; each is
 * printed from parts, so the command's own echo never holds the line a spec looks for. Returns once the program is
 * reading.
 */
export async function startMouseTracking(page: Page, terminal: Locator): Promise<void> {
  await page.keyboard.type("printf 'alpha %s gamma\\n' beta; printf 'delta %s zeta\\n' epsilon\r");
  await expect(terminal).toContainText("delta epsilon zeta", { timeout: 15_000 });
  await page.keyboard.type("printf '\\033[?1003h\\033[?1006h'; stty -icanon -echo min 1 time 0; echo READY; cat -v\r");
  await expect(terminal).toContainText("READY", { timeout: 15_000 });
}

/** Sends the program ^C and puts the shell's line discipline back, so the terminal ends cleanly. */
export async function stopMouseTracking(page: Page): Promise<void> {
  await page.keyboard.press("Control+C");
  await page.keyboard.type("stty sane\r");
}

const REPORT = /\^\[\[<\d+;\d+;(\d+)[Mm]/g;

/** The row of every mouse report the program has echoed so far, in the order they reached it. */
export async function reportedRows(terminal: Locator): Promise<number[]> {
  const text = await terminal.evaluate((root) => root.textContent ?? "");
  return [...text.matchAll(REPORT)].map((match) => Number(match[1]));
}

/** The row a mouse report names for the screen row that holds `text`: 1 for the top row of the screen. */
export async function reportRowOf(terminal: Locator, text: string): Promise<number> {
  return terminal.evaluate((root, wanted) => {
    const rows = [...root.querySelectorAll(".term-row:not(.term-scrollback-row)")];
    const index = rows.findIndex((row) => row.textContent?.includes(wanted) === true);
    if (index < 0) throw new Error(`no screen row holds ${wanted}`);
    return index + 1;
  }, text);
}
