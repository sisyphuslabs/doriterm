import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { agentRow, endAgent, startAgent } from "./agents.ts";
import { expect, laidOutBox, opened, test } from "./fixtures.ts";
import { gridSize } from "./core-size.ts";
import { seedSpaces } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { expectTouchTargets, key, keysBar, openPhoneTerminal, settledGrid } from "./phone-key-bar.ts";

// A touch phone. The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block", hasTouch: true, isMobile: true });

/** An iPhone's home inset, which headless Chromium does not have: the page reads it through `--safe-bottom`. */
async function homeInset(page: Page, px: number): Promise<void> {
  await page.addInitScript((bottom) => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = `:root { --safe-bottom: ${bottom}px !important; }`;
      document.head.append(style);
    });
  }, px);
}

const rows = async (page: Page): Promise<number> =>
  Number((await gridSize(page.locator("[data-terminal]"))).split(" ")[0]);

/**
 * With the keyboard down, a phone terminal's bottom is its keys row on the home inset, as in the Herdr app: no tabs strip
 * under it and no row of its own for a round button (#2879). The terminal takes everything from the header down to the
 * keys, and its grid fills it; how many rows that is follows the platform's font (on a Mac 390x844 went from 37 to 41
 * rows and 844x390 from 11 to 15).
 */
for (const { name, width, height, inset } of [
  { name: "portrait 390x844", width: 390, height: 844, inset: 34 },
  { name: "landscape 844x390", width: 844, height: 390, inset: 21 },
]) {
  test.describe(name, () => {
    test.use({ screen: { width: Math.min(width, height), height: Math.max(width, height) } });

    test("a terminal in a tab takes the screen from its header to its keys, the keys on the home inset", async ({
      page,
    }) => {
      await homeInset(page, inset);
      // Opened upright, then turned, as a phone is: a touch screen whose short side is a phone's keeps the phone shell.
      const terminal = await openPhoneTerminal(page, Math.min(width, height), "resize");
      await page.setViewportSize({ width, height });
      await expect(key(page, "Show keyboard")).toBeVisible();
      await settledGrid(page, terminal);
      const [header, screen, bar] = await Promise.all([
        laidOutBox(page.getByRole("banner")),
        laidOutBox(terminal),
        laidOutBox(keysBar(page)),
      ]);
      expect(Math.abs(bar.y + bar.height - (height - inset))).toBeLessThanOrEqual(1);
      expect(Math.abs(screen.y - (header.y + header.height))).toBeLessThanOrEqual(1);
      expect(Math.abs(screen.y + screen.height - bar.y)).toBeLessThanOrEqual(1);
      const row = await laidOutBox(terminal.locator(".term-row:not(.term-scrollback-row)").first());
      expect(screen.height - (await rows(page)) * row.height).toBeLessThan(row.height + 8);
      // The header keeps one 48 px line; the tabs chip is in it only on a phone on its side (#2879).
      expect(header.height).toBe(48);
      const chip = page
        .getByRole("banner")
        .locator("[data-phone-tabs]")
        .getByRole("button", { name: /^Switch tab, / });
      if (width < 430) await expect(chip).toHaveCount(0);
      else await expect(chip).toHaveText("1/1");
      await expectTouchTargets(page.getByRole("banner"));
    });
  });
}

/**
 * One tabs switch at every width: the header's chip from 430 px, the session sheet's Tabs row below it, never both and
 * never neither (Tailwind's max-[430px] is width < 430, the exact complement of min-[430px]).
 */
for (const width of [429, 430]) {
  test(`at ${width} px exactly one tabs switch is drawn`, async ({ page }) => {
    await openPhoneTerminal(page, width, "resize");
    const header = page.getByRole("banner");
    const chip = header.locator("[data-phone-tabs]").getByRole("button", { name: /^Switch tab, / });
    // The chip is read first: an open sheet is modal, and hides the header from the accessibility tree.
    if (width < 430) await expect(chip).toHaveCount(0);
    else await expect(chip).toBeVisible();
    await header.getByRole("button", { name: /^Session actions for / }).click();
    const row = page.getByRole("dialog").getByRole("button", { name: /^Switch tab, / });
    await expect(page.getByRole("dialog")).toBeVisible();
    if (width < 430) await expect(row).toBeVisible();
    else await expect(row).toHaveCount(0);
  });
}

/** A tab name wider than any phone's title column: 32 characters. */
const LONG_TAB = "a-tab-whose-name-runs-32-chars-x";

/**
 * On a portrait phone the header is as it was before the tabs chip: one 48 px line, the title ending in an ellipsis
 * beside the needs-you pill (#2865) and the mic, which keeps its place at every width. The chip is not drawn; the
 * session sheet's Tabs row opens the same switch sheet (#2879).
 */
for (const width of [390, 320]) {
  test(`at ${width}, a long tab name beside the needs-you pill keeps the header one 48 px line, and the tabs switch is a tap away`, async ({
    page,
  }) => {
    const folder = mkdtempSync(join(tmpdir(), "rows-header-"));
    const shells = [1, 2, 3].map((n) => {
      const out = hcOn("host", [
        "run",
        "--bg",
        "--name",
        `rows-${width}-${n}`,
        "--cwd",
        folder,
        "--",
        "env",
        "PS1=$ ",
        "sh",
      ]);
      return String((JSON.parse(out) as { address: string }).address);
    });
    const blocked = startAgent("host", `rows-wait-${width}`, "blocked");
    try {
      seedSpaces([
        {
          id: `spc-rows-${width}`,
          name: "rows",
          folder,
          tabs: shells.map((terminal, index) => ({
            id: `tb-rows-${width}-${index}`,
            name: index === 0 ? LONG_TAB : `rows-tab-${index + 1}`,
            terminal,
          })),
        },
      ]);
      await page.setViewportSize({ width, height: 700 });
      await page.goto("/");
      await agentRow(page, `rows-${width}-1`, false).click({ timeout: 20_000 });
      const bar = page.getByRole("banner");
      await expect(bar.getByRole("heading", { level: 1, name: LONG_TAB, exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await expect(bar.getByRole("button", { name: /needs you, open the next$/ })).toBeVisible({ timeout: 15_000 });
      await expect(bar.getByRole("button", { name: /^Dictate into / })).toBeVisible();
      await expect(bar.locator("[data-title-lines]")).toHaveText(/\u2026$/);
      await expect.poll(async () => (await laidOutBox(bar)).height).toBe(48);
      expect(await bar.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

      await expect(bar.locator("[data-phone-tabs]").getByRole("button", { name: /^Switch tab, / })).toHaveCount(0);
      await bar.getByRole("button", { name: /^Session actions for / }).click();
      const actions = page.getByRole("dialog", { name: LONG_TAB });
      const row = actions.getByRole("button", { name: `Switch tab, rows, ${LONG_TAB}, tab 1 of 3`, exact: true });
      await expect(row).toHaveText("Tabs1/3");
      expect((await laidOutBox(row)).height).toBeGreaterThanOrEqual(44);
      await row.click();
      await expect(actions).toHaveCount(0);
      const sheet = page.getByRole("dialog", { name: "Switch" });
      await opened(sheet);
      await agentRow(sheet.getByRole("region", { name: "rows" }), "rows-tab-3", false).click();
      await expect(sheet).toBeHidden();
      await expect(bar.getByRole("heading", { level: 1, name: "rows-tab-3", exact: true })).toBeVisible({
        timeout: 15_000,
      });
    } finally {
      seedSpaces([]);
      endAgent("host", blocked);
      for (const shell of shells) endAgent("host", shell);
      rmSync(folder, { recursive: true, force: true });
    }
  });
}
