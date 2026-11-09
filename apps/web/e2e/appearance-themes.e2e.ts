import type { Page } from "@playwright/test";
import { endAgent } from "./agents.ts";
import { followSystemAppearance, expect, openNewTerminal as openTerminal, test } from "./fixtures.ts";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

/** Terminals these cases open, ended after each so later specs start from the same count. */
const opened: string[] = [];
test.afterEach(() => {
  for (const address of opened.splice(0)) endAgent("host", address);
});

async function openNewTerminal(page: Page) {
  const terminal = await openTerminal(page);
  const address = await terminal.getAttribute("data-terminal");
  if (address !== null) opened.push(address);
  return terminal;
}

/** A colour as the browser computes it, so a token and a painted background compare as rgb(). */
const computed = (page: Page, color: string) =>
  page.evaluate((value) => {
    const probe = document.createElement("span");
    probe.style.color = value;
    document.body.append(probe);
    const rgb = getComputedStyle(probe).color;
    probe.remove();
    return rgb;
  }, color);

/** The theme's terminal background token and the focused terminal's painted background. */
const backgrounds = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--term-bg").trim();
    document.body.append(probe);
    const token = getComputedStyle(probe).color;
    probe.remove();
    const terminal = document.querySelector('[data-focused="true"] .wterm');
    return { token, terminal: terminal === null ? null : getComputedStyle(terminal).backgroundColor };
  });

async function openAppearance(page: Page): Promise<void> {
  await page.goto("/settings");
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Appearance" }).click();
}

const list = (page: Page, kind: "Dark" | "Light") => page.getByRole("radiogroup", { name: `${kind} themes` });
const showList = (page: Page, kind: "Dark" | "Light") =>
  page
    .getByLabel("Theme list")
    .getByRole("button", { name: new RegExp(`^${kind} \\d+$`) })
    .click();

test("the library lists twenty dark and twenty light themes, and a search narrows them", async ({ page }) => {
  await openAppearance(page);
  await showList(page, "Dark");
  await expect(list(page, "Dark").getByRole("radio")).toHaveCount(20);
  await showList(page, "Light");
  await expect(list(page, "Light").getByRole("radio")).toHaveCount(20);
  await page.getByRole("searchbox", { name: "Search themes" }).fill("solarized");
  await expect(list(page, "Light").getByRole("radio")).toHaveText([/Solarized Light/]);
  await expect(page.getByLabel("Theme list").getByRole("button", { name: "Dark 1" })).toBeVisible();
});

test("a picked theme re-themes the app and its terminals, and the pick survives a reload", async ({ page }) => {
  await openAppearance(page);
  await page.getByLabel("Appearance", { exact: true }).getByRole("button", { name: "Dark" }).click();
  await showList(page, "Dark");
  await list(page, "Dark")
    .getByRole("radio", { name: /Dracula/ })
    .click();
  const dracula = await computed(page, "#282a36");
  await expect.poll(async () => (await backgrounds(page)).token).toBe(dracula);

  await page.reload();
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Appearance" }).click();
  await expect(page.getByLabel("Appearance", { exact: true }).getByRole("button", { name: "Dark" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(list(page, "Dark").getByRole("radio", { name: /Dracula/ })).toBeChecked();

  await page.goto("/");
  await openNewTerminal(page);
  await expect.poll(async () => (await backgrounds(page)).terminal).toBe(dracula);
});

test("following the system shows the dark pick when dark and the light pick when light, terminal included", async ({
  page,
}) => {
  await followSystemAppearance(page);
  await page.emulateMedia({ colorScheme: "light" });
  await openAppearance(page);
  await expect(page.getByLabel("Appearance", { exact: true }).getByRole("button", { name: "System" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await showList(page, "Dark");
  await list(page, "Dark").getByRole("radio", { name: /Nord/ }).click();
  await showList(page, "Light");
  await list(page, "Light")
    .getByRole("radio", { name: /^Tomorrow/ })
    .click();

  await page.goto("/");
  await openNewTerminal(page);
  const tomorrow = await computed(page, "#ffffff");
  const nord = await computed(page, "#2e3440");
  await expect.poll(async () => (await backgrounds(page)).terminal).toBe(tomorrow);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(async () => (await backgrounds(page)).terminal, { message: "terminal on dark" }).toBe(nord);
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(async () => (await backgrounds(page)).terminal, { message: "terminal on light" }).toBe(tomorrow);
});

test("a picked theme whose terminal colours are faint names the remedy, and the note goes with it", async ({
  page,
}) => {
  await openAppearance(page);
  await page.getByLabel("Appearance", { exact: true }).getByRole("button", { name: "Light" }).click();
  await showList(page, "Light");
  const note = page.getByRole("note");
  await expect(note).toHaveCount(0);
  await list(page, "Light")
    .getByRole("radio", { name: /Everforest Light/ })
    .click();
  await expect(note).toContainText("Everforest Light");
  await expect(note).toContainText("palette");
  await list(page, "Light").getByRole("radio", { name: "Day Doriterm", exact: true }).click();
  await expect(note).toHaveCount(0);
});
