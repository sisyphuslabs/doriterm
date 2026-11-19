// Settings > Machines installs the agent skill on this computer and on the added machine through each one's host
// (#2653). The e2e hosts run with their own temporary HOME, so no real skill directory is touched. With CAPTURE=1 it also
// saves the rows before and after Install at 1440 and 390 (day) under $SHOTS_DIR (default $TMPDIR/shots), never into docs/.
import type { Locator, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./fixtures.ts";
import { E2E_HOST_ENV } from "./config.ts";
import { MACHINE_ENV, MACHINE_NAME } from "./machine.ts";
import { skillOnHost } from "./agent-skill-host.ts";
import { STATE_BOUND_MS } from "./machine-switch.ts";

const THIS_COMPUTER = "studio";
const CAPTURE = process.env["CAPTURE"] === "1";
const SHOTS = process.env["SHOTS_DIR"] || join(tmpdir(), "shots");
const INSTALL_BOUND_MS = 30_000;

async function rowOf(page: Page, name: string): Promise<Locator> {
  await page.goto("/settings#machines");
  const row = page.getByRole("list", { name: "Machines" }).getByRole("listitem").filter({ hasText: name });
  await expect(row).toContainText(name === THIS_COMPUTER ? "Online" : "Connected", { timeout: STATE_BOUND_MS });
  return row;
}

const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const;

/** Saves the row at each width; the hosts are shared, so one test shoots both widths around a single Install. */
async function shoot(page: Page, row: Locator, name: string): Promise<void> {
  if (!CAPTURE) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const size of WIDTHS) {
    // oxlint-disable-next-line no-await-in-loop -- one viewport at a time on the same page
    await page.setViewportSize(size);
    // oxlint-disable-next-line no-await-in-loop -- as above
    await row.scrollIntoViewIfNeeded();
    // oxlint-disable-next-line no-await-in-loop -- as above
    await page.evaluate(() => document.fonts.ready);
    // oxlint-disable-next-line no-await-in-loop -- as above
    await page.screenshot({ path: join(SHOTS, `${name}-${size.width}-day.png`) });
  }
  await page.setViewportSize(WIDTHS[0]);
}

async function installOn(page: Page, name: string, slug: string, savedFile: string): Promise<void> {
  await skillOnHost(savedFile, "uninstall");
  const row = await rowOf(page, name);
  await expect(row).toContainText("Agent skill not installed", { timeout: STATE_BOUND_MS });
  await shoot(page, row, `agent-skill-${slug}-before`);
  await row.getByRole("button", { name: `Install agent skill on ${name}` }).click();
  await expect(row).toContainText(/Agent skill installed v\S+/, { timeout: INSTALL_BOUND_MS });
  await expect(row.getByRole("button", { name: /agent skill/ })).toHaveCount(0);
  await shoot(page, row, `agent-skill-${slug}-after`);
}

test.describe("Settings, agent skill", () => {
  test.use({ viewport: WIDTHS[0], colorScheme: "light" });

  test("this computer's row offers Install and then names the installed version", async ({ page }) => {
    test.setTimeout(INSTALL_BOUND_MS * 2);
    await installOn(page, THIS_COMPUTER, "this-computer", E2E_HOST_ENV);
  });

  test("the added machine's row offers Install and then names the installed version", async ({ page }) => {
    test.setTimeout(INSTALL_BOUND_MS * 2);
    await installOn(page, MACHINE_NAME, "machine", MACHINE_ENV);
  });
});
