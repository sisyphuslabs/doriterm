import { execFileSync } from "node:child_process";
import type { Locator, Page } from "@playwright/test";
import { endAgent } from "./agents.ts";
import { E2E_HOST_ENV } from "./config.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { type HcSocket, routeHcSocket } from "./hc-socket.ts";
import { openPhoneTerminal, PHONE } from "./phone-key-bar.ts";
import { readSavedEnv } from "./saved-env.ts";
import { tabs } from "./tab-strip.ts";

test.use({ serviceWorkers: "block" });

const opened: string[] = [];
test.afterEach(() => {
  for (const address of opened.splice(0)) endAgent("host", address);
});

/** The core's own screen of a terminal, read with hc: what the program printed, whether or not the page has it. */
function coreScreen(address: string): string {
  const { hc, env } = readSavedEnv(E2E_HOST_ENV);
  return execFileSync(hc, ["read", address], { env: { ...process.env, ...env }, encoding: "utf8" });
}

/**
 * Prints a screen's worth into the terminal, drops the link, prints far more than a screen while it is down (read back
 * from the core), and brings the link back; returns once output typed after the reattach shows, so the repaint has been
 * drawn. `whileDown` runs once the page has noticed the drop.
 */
async function reconnectPastAScreen(
  page: Page,
  link: HcSocket,
  terminal: Locator,
  whileDown: () => Promise<void> = async () => undefined,
): Promise<void> {
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  await page.keyboard.type("for i in $(seq 1 200); do echo kept-$i; done");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("kept-200", { timeout: 30_000 });
  await page.keyboard.type("sleep 1; for i in $(seq 1 400); do echo away-$i; done");
  await page.keyboard.press("Enter");
  await link.drop(true);
  await expect.poll(() => coreScreen(address), { timeout: 30_000 }).toContain("away-400");
  await whileDown();
  link.restore();
  await page.keyboard.type("echo back-$((1+1))");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("back-2", { timeout: 30_000 });
}

/**
 * hc's attach has no cursor to resume from, so a reattach repaints the screen alone (#1997): what scrolled off the core's
 * screen while the line was down never reaches the view. Until the core can resume (herdrdev/herdr-core#233), the status
 * bar says so after the reconnect, beside the connection status and outside the terminal, until it is dismissed (#2033).
 */
test("after a reconnect the status bar says output from while the line was down may be missing (#2033)", async ({
  page,
}) => {
  const link = await routeHcSocket(page);
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  opened.push(address);
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type("for i in $(seq 1 200); do echo kept-$i; done");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("kept-200", { timeout: 30_000 });
  const note = page.getByRole("status").filter({ hasText: "Output from while disconnected may be missing" });
  // A first attach has nothing missing: no note.
  await expect(note).toHaveCount(0);

  // The line goes down, and while it is down the program prints far more than a screen.
  await page.keyboard.type("sleep 1; for i in $(seq 1 400); do echo away-$i; done");
  await page.keyboard.press("Enter");
  await link.drop(true);
  // Until the connection is back nothing is known to be missing: the bar says it reconnects, not that output is lost.
  await expect(page.getByRole("status").filter({ hasText: /Reconnecting/ })).toBeVisible({ timeout: 15_000 });
  await expect(note).toHaveCount(0);
  await expect.poll(() => coreScreen(address), { timeout: 30_000 }).toContain("away-400");
  await expect(note).toHaveCount(0);
  link.restore();
  // Output after the reattach comes behind its repaint on the same stream: once it shows, the repaint has been drawn.
  await page.keyboard.type("echo back-$((1+1))");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("back-2", { timeout: 30_000 });

  // The note is in the status bar, not over the terminal, and it stays until it is dismissed.
  await expect(note).toBeVisible();
  await expect(terminal.getByRole("status")).toHaveCount(0);
  await note.getByRole("button", { name: "Dismiss" }).click();
  await expect(note).toHaveCount(0);
});

/**
 * The note is the terminal's own: a terminal opened after the reconnect lost nothing, so with it focused the bar says
 * nothing, and the note comes back with the terminal it was raised for (#2257).
 */
test("the reconnect note belongs to the terminal that lost output, not to one opened after (#2257)", async ({
  page,
}) => {
  test.slow();
  const link = await routeHcSocket(page);
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  opened.push((await terminal.getAttribute("data-terminal")) ?? "");
  await terminal.getByRole("textbox").focus();
  await reconnectPastAScreen(page, link, terminal);
  const note = page.locator("[data-history-gap-status]");
  await expect(note).toBeVisible();

  const fresh = await openNewTerminal(page);
  opened.push((await fresh.getAttribute("data-terminal")) ?? "");
  await expect(tabs(page)).toHaveCount(2);
  await expect(note).toHaveCount(0);
  await tabs(page).nth(0).click();
  await expect(note).toBeVisible();
});

/**
 * The phone says the note in the line under the terminal's header, where it says "Reconnecting": the line hands over
 * from one to the other at the same height, so the terminal is not fitted again while the repaint lands (#2257). The
 * line sits outside the terminal, and Dismiss takes it away. After a reconnect the note takes over from Reconnecting,
 * which is one line at every phone width, so the hand-over keeps its height below 390 px too, where the Offline sentence
 * wraps (DESIGN.md 5 (e)) and the line changes height as Offline gives way to Reconnecting (#2406). A note already
 * showing, or one raised while Offline shows, appears as Offline clears, with no repaint in flight.
 */
for (const width of [390, 320]) {
  test.describe(`on a phone ${width} px wide`, () => {
    test.use({ ...PHONE, viewport: { width, height: 844 } });

    test("the note takes over the reconnecting line at its height, outside the terminal (#2257, #2406)", async ({
      page,
    }) => {
      test.slow();
      const link = await routeHcSocket(page);
      const terminal = await openPhoneTerminal(page);
      opened.push((await terminal.getAttribute("data-terminal")) ?? "");
      await reconnectPastAScreen(page, link, terminal, async () => {
        await expect(page.getByRole("status").filter({ hasText: /Reconnecting/ })).toBeVisible();
        // From here, every height the terminal is laid out at.
        await terminal.evaluate((element) => {
          const heights = [element.getBoundingClientRect().height];
          Object.assign(window, { terminalHeights: heights });
          new ResizeObserver(() => heights.push(element.getBoundingClientRect().height)).observe(element);
        });
      });
      const note = page.locator("[data-history-gap-status]");
      await expect(note).toBeVisible();
      const heights = await page.evaluate(() => Reflect.get(window, "terminalHeights") as number[]);
      expect(new Set(heights).size, `terminal heights through the reconnect: ${heights.join(", ")}`).toBe(1);

      const box = await terminal.boundingBox();
      const line = await note.boundingBox();
      if (box === null || line === null) throw new Error("the terminal or the note is not laid out");
      expect(line.y + line.height).toBeLessThanOrEqual(box.y + 0.5);
      await page.getByRole("button", { name: "Dismiss" }).click();
      await expect(note).toHaveCount(0);
    });
  });
}

test.describe("on a phone", () => {
  test.use({ ...PHONE });

  /**
   * A terminal left while its line was down and opened again later is a new view: its first attach plays its history
   * back, so nothing it shows is missing and it says nothing (#2279 review).
   */
  test("a terminal opened again after the reconnect plays its history back and says nothing is missing", async ({
    page,
  }) => {
    test.slow();
    const link = await routeHcSocket(page);
    const terminal = await openPhoneTerminal(page);
    const address = (await terminal.getAttribute("data-terminal")) ?? "";
    opened.push(address);
    await page.keyboard.type("for i in $(seq 1 200); do echo kept-$i; done");
    await page.keyboard.press("Enter");
    await expect(terminal).toContainText("kept-200", { timeout: 30_000 });
    await page.keyboard.type("sleep 1; for i in $(seq 1 400); do echo away-$i; done");
    await page.keyboard.press("Enter");
    await link.drop(true);
    await expect.poll(() => coreScreen(address), { timeout: 30_000 }).toContain("away-400");
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
    link.restore();
    await expect(page.getByRole("status").filter({ hasText: /Reconnecting|Offline/ })).toHaveCount(0, {
      timeout: 30_000,
    });

    await page.goForward();
    const again = page.locator(`[data-terminal="${address}"]`);
    await expect(again).toContainText("away-400", { timeout: 30_000 });
    await expect(page.locator("[data-history-gap-status]")).toHaveCount(0);
  });
});
