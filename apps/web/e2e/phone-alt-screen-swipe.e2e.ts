import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { openPhoneTerminal, PHONE } from "./phone-key-bar.ts";
import { Touch, type TouchPoint } from "./touch.ts";

test.use({ serviceWorkers: "block", ...PHONE });

/** The wheel reports the program has echoed so far: 64 for a notch up, 65 for one down. */
async function wheelReports(terminal: Locator): Promise<string[]> {
  const text = await terminal.evaluate((root) => root.textContent ?? "");
  return [...text.matchAll(/\^\[\[<(6[45]);\d+;\d+M/g)].map((match) => match[1] ?? "");
}

/** Counts each touchmove that reaches the window, and how many of them the page had cancelled by then. */
async function countTouchMoves(page: Page): Promise<() => Promise<{ moves: number; cancelled: number }>> {
  await page.evaluate(() => {
    const counts = { moves: 0, cancelled: 0 };
    Object.assign(window, { swipeCounts: counts });
    window.addEventListener("touchmove", (event) => {
      counts.moves++;
      if (event.defaultPrevented) counts.cancelled++;
    });
  });
  return () =>
    page.evaluate(() => ({
      ...(window as unknown as { swipeCounts: { moves: number; cancelled: number } }).swipeCounts,
    }));
}

async function swipe(touch: Touch, from: TouchPoint, to: TouchPoint): Promise<void> {
  await touch.down(from);
  await touch.drag(from, to, 10);
  await touch.up(to);
}

test("on the alternate screen a swipe scrolls the program that tracks the mouse, and never the page (#1996)", async ({
  page,
}) => {
  const terminal = await openPhoneTerminal(page);
  // A full-screen program, as herdr is: the alternate screen, every button reported in SGR, each byte echoed visibly.
  await page.keyboard.type(
    "printf '\\033[?1049h\\033[?1000h\\033[?1006h\\033[H'; echo ALT-$((1995+1)); stty -icanon -echo min 1 time 0; cat -v\r",
  );
  await expect(terminal).toContainText("ALT-1996", { timeout: 15_000 });
  const counted = await countTouchMoves(page);
  const box = await terminal.boundingBox();
  if (box === null) throw new Error("the terminal has no box");
  const x = box.x + box.width / 2;
  const top = { x, y: box.y + 60 };
  const bottom = { x, y: box.y + 260 };
  const touch = await Touch.on(page);

  // A finger moving down scrolls back, as on any touch screen: the program hears the wheel go up.
  await swipe(touch, top, bottom);
  await expect.poll(() => wheelReports(terminal)).toContain("64");
  expect(await wheelReports(terminal)).not.toContain("65");
  await swipe(touch, bottom, top);
  await expect.poll(() => wheelReports(terminal)).toContain("65");

  // The grid has nothing to scroll here: a move left to the browser would pan the page, and a phone's pull-to-refresh
  // reloads the app.
  const { moves, cancelled } = await counted();
  expect(moves).toBeGreaterThan(0);
  expect(cancelled).toBe(moves);

  await page.keyboard.press("Control+C");
  await page.keyboard.type("printf '\\033[?1000l\\033[?1006l\\033[?1049l'; stty sane\r");
});
