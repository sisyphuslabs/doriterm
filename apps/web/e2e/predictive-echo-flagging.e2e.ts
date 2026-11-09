import type { Locator, Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { type HcSocket, routeHcSocket } from "./hc-socket.ts";
import { PHONE, openPhoneTerminal } from "./phone-key-bar.ts";
import { untilShellReads } from "./prediction-probe.ts";

// The real predictor underlines a drawn cell only while it is flagging, as mosh does: its echo SRTT above 160 ms
// (cleared at 100 ms or less), or a glitch. On a link that answers in 120 ms a prediction is drawn plain; at a relay's
// 300 ms it is underlined (#1439 HIGH 2).

const prompt = (terminal: Locator) =>
  terminal.locator(".term-row:not(.term-scrollback-row)").filter({ hasText: /^\$ / });

const SETTLE_KEYS = "abcdefghij";

/**
 * One key echoed at once, so the predictor's SRTT starts low and it is not flagging, then ten keys each echoed over a
 * link holding host frames `ms`, so the SRTT it measures follows that round trip.
 */
async function settle(page: Page, terminal: Locator, link: HcSocket, ms: number): Promise<void> {
  let line = "";
  for (const [delay, key] of [[0, "e"], ...[...SETTLE_KEYS].map((each) => [ms, each] as const)] as const) {
    link.delay(delay);
    line += key;
    // oxlint-disable-next-line no-await-in-loop -- each key's echo is a sample the next one builds on
    await page.keyboard.type(key);
    // oxlint-disable-next-line no-await-in-loop -- as above
    await expect(prompt(terminal).filter({ hasText: `$ ${line}` })).toHaveCount(1, { timeout: 15_000 });
  }
}

/** The computed text-decoration-line of a key's predicted cell, read while the host's echo of it is held. */
async function drawnDecoration(page: Page, terminal: Locator, link: HcSocket): Promise<string> {
  const release = link.holdFromHost("");
  await page.keyboard.type("z");
  const cell = terminal.locator(".term-prediction-cell");
  await expect(cell).toHaveText(["z"]);
  const line = await cell.evaluate((element) => getComputedStyle(element).textDecorationLine);
  release();
  await expect(prompt(terminal).filter({ hasText: `$ e${SETTLE_KEYS}z` })).toHaveCount(1, { timeout: 15_000 });
  await expect(cell).toHaveCount(0, { timeout: 15_000 });
  await page.keyboard.press("Control+U");
  return line;
}

for (const device of ["desktop", "phone"] as const) {
  test.describe(device, () => {
    test.use(device === "phone" ? { ...PHONE, serviceWorkers: "block" } : { serviceWorkers: "block" });

    /** A terminal at its prompt, predictions always drawn, its host frames routed through the spec. */
    async function open(page: Page): Promise<{ readonly terminal: Locator; readonly link: HcSocket }> {
      const link = await routeHcSocket(page);
      await page.addInitScript(() => localStorage.setItem("doriface.terminal.predict-typing", "always"));
      let terminal: Locator;
      if (device === "phone") terminal = await openPhoneTerminal(page);
      else {
        await page.goto("/");
        terminal = await openNewTerminal(page);
      }
      await terminal.getByRole("textbox").focus();
      await untilShellReads(page, terminal);
      return { terminal, link };
    }

    test("at a 120 ms round trip a predicted cell is drawn with no underline", async ({ page }) => {
      test.setTimeout(60_000);
      const { terminal, link } = await open(page);
      await settle(page, terminal, link, 120);
      expect(await drawnDecoration(page, terminal, link)).toBe("none");
    });

    test("at a 300 ms round trip a predicted cell is underlined", async ({ page }) => {
      test.setTimeout(60_000);
      const { terminal, link } = await open(page);
      await settle(page, terminal, link, 300);
      expect(await drawnDecoration(page, terminal, link)).toBe("underline");
    });
  });
}
