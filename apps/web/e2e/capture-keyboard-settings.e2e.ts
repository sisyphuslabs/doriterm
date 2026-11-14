// Visual QA captures of Settings > Keyboard and the bar it configures, at 390 and 768, in both themes (#770).
// CAPTURE=1 bunx playwright test capture-keyboard-settings
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { E2E_HOST_PORT, E2E_TOKEN } from "./config.ts";
import { expect, test } from "./fixtures.ts";
import { openPhoneTerminal, PHONE, showKeyboard } from "./phone-key-bar.ts";

const OUT = join(import.meta.dirname, "../../../docs/design/app");
const CONNECTION = JSON.stringify({
  mode: "loopback",
  relayUrl: "",
  directUrl: "",
  hostId: "",
  loopbackUrl: `ws://127.0.0.1:${E2E_HOST_PORT}/v1/hc`,
  token: E2E_TOKEN,
});
const BODY = "[data-slot='settings-body']";
const HERO = "[data-key-bar-hero]";

test.use({ serviceWorkers: "block", ...PHONE });

test.skip(process.env["CAPTURE"] !== "1", "captures run only with CAPTURE=1");

const seed =
  (theme: "day" | "night") =>
  ([connection]: readonly [string]) => {
    localStorage.setItem("doriface.appearance", JSON.stringify({ theme, custom: [] }));
    localStorage.setItem("doriface.connection", connection);
  };

for (const theme of ["day", "night"] as const) {
  for (const width of [390, 768] as const) {
    test(`keyboard settings ${width} ${theme}`, async ({ browser }) => {
      const context = await browser.newContext({
        colorScheme: theme === "day" ? "light" : "dark",
        viewport: { width, height: width === 390 ? 844 : 900 },
      });
      await context.addInitScript(seed(theme), [CONNECTION] as const);
      const page = await context.newPage();
      try {
        await page.goto("/settings");
        await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible({ timeout: 20_000 });
        if (width === 390) await page.getByRole("tab", { name: "Keyboard" }).click();
        else await page.getByRole("button", { name: "Keyboard", exact: true }).click();
        await expect(page.locator(HERO)).toBeVisible();
        await seedBar(page);
        await page.screenshot({ path: join(OUT, `keyboard-settings-${width}-${theme}.png`) });
        await page.getByRole("button", { name: "Edit", exact: true }).click();
        await expect(page.getByRole("button", { name: "Done", exact: true })).toBeVisible();
        await settled(page);
        await page.screenshot({ path: join(OUT, `keyboard-settings-${width}-${theme}-edit.png`) });
        // The body scrolls on a desktop, the page on a phone (#2533): both go to the end, whichever owns the scroll.
        const body = page.locator(BODY);
        await body.evaluate((element) => {
          element.scrollTo(0, element.scrollHeight);
          window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
        });
        await settled(page);
        await page.screenshot({ path: join(OUT, `keyboard-settings-${width}-${theme}-edit-end.png`) });
        await body.evaluate((element) => {
          element.scrollTo(0, 0);
          window.scrollTo({ top: 0, behavior: "instant" });
        });
        await page.getByRole("button", { name: "Done", exact: true }).click();
        await captureSheet(page, /^Keys/, "Add keys", width, theme);
        await captureSheet(page, /^Packs/, "Packs", width, theme);
        await captureSheet(page, /^Your keys/, "Your keys", width, theme);
      } finally {
        await context.close();
      }
    });
  }
}

/** A bar a person would actually have: the tmux pack leading it, and one key of their own. */
async function seedBar(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Packs/ }).click();
  await expect(page.getByRole("dialog", { name: "Packs" })).toBeVisible();
  await page.getByRole("switch", { name: "Add Tmux pack" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Packs" })).toBeHidden();
  await expect(page.getByRole("button", { name: /^Packs/ })).toContainText("Tmux");
  await page.getByRole("button", { name: /^Your keys/ }).click();
  await expect(page.getByRole("dialog", { name: "Your keys" })).toBeVisible();
  await page.getByLabel("Key label").fill("Interrupt");
  await page.getByLabel("Keys it sends").fill("Ctrl+C");
  await page.getByRole("button", { name: "Add key" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Your keys" })).toBeHidden();
  await expect(page.getByRole("button", { name: /^Your keys/ })).toContainText("1");
}

async function captureSheet(
  page: Page,
  row: RegExp,
  title: string,
  width: number,
  theme: "day" | "night",
): Promise<void> {
  await page.getByRole("button", { name: row }).click();
  const dialog = page.getByRole("dialog", { name: title });
  await expect(dialog).toBeVisible();
  await settled(page, dialog);
  if (title === "Your keys") {
    await page.getByLabel("Key label").fill("Tab left");
    await page.getByLabel("Keys it sends").fill("Alt+Left");
  }
  await page.screenshot({ path: join(OUT, `${slug(title)}-${width}-${theme}.png`) });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}

/** A capture is evidence only once the sheet stopped sliding: its top edge stays put between two samples. */
async function settled(page: Page, dialog?: Locator): Promise<void> {
  if (dialog === undefined) {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return;
  }
  let previous: number | null = null;
  await expect
    .poll(
      async () => {
        const box = await dialog.boundingBox();
        const top = box === null ? null : Math.round(box.y);
        const still = top !== null && top === previous;
        previous = top;
        return still;
      },
      { timeout: 5_000, intervals: [80] },
    )
    .toBe(true);
}

for (const theme of ["day", "night"] as const) {
  test(`keys bar ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openPhoneTerminal(page, 390);
    await showKeyboard(page, 336);
    await expect(page.getByRole("toolbar", { name: "Terminal keys" })).toBeVisible();
    await page.screenshot({ path: join(OUT, `keys-bar-390-${theme}.png`) });
  });
}

function slug(title: string): string {
  return title === "Add keys" ? "key-picker" : title === "Packs" ? "packs-sheet" : "your-keys";
}
