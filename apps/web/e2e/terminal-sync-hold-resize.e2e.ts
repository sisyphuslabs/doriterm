import { expect, openNewTerminal, test } from "./fixtures.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

/** The hold a synchronized update gets before the screen paints anyway (@wterm/dom's SYNCHRONIZED_OUTPUT_TIMEOUT_MS). */
const HOLD_MS = 1_000;

test("an update a program left open paints a second after it opened, however often the view resizes meanwhile (#853)", async ({
  page,
}) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  // The program opens an update, draws into it and never ends it, as one killed mid-frame does.
  await page.keyboard.type("clear; printf '\\033[?2026hopen-%s\\n' 853");
  await page.keyboard.press("Enter");
  const opened = Date.now();

  // A divider dragged for four seconds: a resize every 200 ms.
  const drag = { on: true };
  const widths = [1280, 1180];
  const dragging = (async () => {
    for (let step = 0; drag.on && Date.now() - opened < 4_000; step += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each resize lands before the next one starts
      await page.setViewportSize({ width: widths[step % 2] ?? 1280, height: 720 });
      // oxlint-disable-next-line no-await-in-loop -- the cadence of a drag is the scenario under test
      await page.waitForTimeout(200);
    }
  })();
  try {
    await expect(terminal.locator(".term-row").filter({ hasText: /^open-853\s*$/ })).toBeVisible({
      timeout: HOLD_MS + 1_000,
    });
    // Released once, it stays released: what the program writes after that shows at once, not a second after the next
    // resize (review of #1097).
    await terminal.getByRole("textbox").press("Enter");
    await page.keyboard.type("printf 'later-%s\\n' 853");
    await page.keyboard.press("Enter");
    await expect(terminal.locator(".term-row").filter({ hasText: /^later-853\s*$/ })).toBeVisible({ timeout: 600 });
  } finally {
    drag.on = false;
    await dragging;
  }
});
