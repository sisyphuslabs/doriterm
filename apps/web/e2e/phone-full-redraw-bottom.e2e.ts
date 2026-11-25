// #2810: an agent's TUI redraws its whole transcript in one synchronized update (clear scrollback, home, clear screen,
// every line again: a model switch, #2745). The phone's view follows output, so it stays at the bottom through that
// redraw and the Jump to bottom button never shows. With WebGL drawing, the history rows' text comes later than the
// frame's pixels; the view's scroll height has to follow the core's line count in that same frame, or the view reads as
// scrolled away (34 px short on a 390x844 screen) and the button stays up.
import { expect, test } from "./fixtures.ts";
import { openPhoneTerminal, PHONE } from "./phone-key-bar.ts";
import { sampleWhile } from "./transcript-follow.ts";

test.use({ serviceWorkers: "block", ...PHONE });

/** 400 lines with Hangul in them, as the transcript, printed by the shell itself so the keyboard types only ASCII. */
const TRANSCRIPT = String.raw`seq -f 'line-%03g \353\252\250\353\215\270 \354\240\204\355\231\230 transcript text' 1 400`;

test("a synchronized redraw of the whole transcript keeps a phone's view at the bottom (#2810)", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  const field = terminal.getByRole("textbox");
  await field.focus();
  await page.keyboard.type(`${TRANSCRIPT}; echo first-done\r`);
  await expect(terminal.locator(".term-row", { hasText: "first-done" }).last()).toBeAttached({ timeout: 30_000 });
  await expect(page.locator("[data-jump-to-bottom]")).toHaveCount(0);

  const redraw = String.raw`printf '\033[?2026h\033[3J\033[H\033[2J'; ${TRANSCRIPT}; printf 'redraw-done\n\033[?2026l'`;
  const samples = await sampleWhile(page, address, async () => {
    await page.keyboard.type(`${redraw}\r`);
    await expect(terminal.locator(".term-row", { hasText: /^redraw-done/ }).last()).toBeAttached({ timeout: 30_000 });
  });
  const away = Math.max(0, ...samples.map((sample) => sample.away));
  expect(away, `the farthest the view got from the bottom across ${samples.length} frames`).toBeLessThan(2);
  await expect(page.locator("[data-jump-to-bottom]")).toHaveCount(0);
});
