import { devices, type Locator, type Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { fakeHostOs } from "./host-os.ts";
import { fakeSoftKeyboard, PHONE, showKeyboard } from "./phone-key-bar.ts";

test.use({ serviceWorkers: "block", ...PHONE });

const channel = (value: number): number => {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
};

const luminance = (value: string): number => {
  const [r = 0, g = 0, b = 0] = (value.match(/[\d.]+/g) ?? []).map(Number);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const ratio = (a: string, b: string): number => {
  const [light = 0, dark = 0] = [luminance(a), luminance(b)].toSorted((left, right) => right - left);
  return (light + 0.05) / (dark + 0.05);
};

const keysBar = (page: Page) => page.getByRole("toolbar", { name: "Terminal keys" });
const hero = (page: Page) => page.locator("[data-key-bar-hero]");

/** The bar's keys in the order it draws them, as the names a screen reader hears. */
async function barNames(scope: Locator): Promise<readonly string[]> {
  return scope
    .locator("button")
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label") ?? ""));
}

async function openSettings(page: Page): Promise<void> {
  await fakeSoftKeyboard(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("tab", { name: "Keyboard" }).click();
}

async function openTerminal(page: Page): Promise<Locator> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("banner").getByRole("button", { name: "New tab" }).click();
  const terminal = page.locator("[data-terminal]");
  await expect(terminal).toContainText("$", { timeout: 15_000 });
  await showKeyboard(page, 336);
  await expect(keysBar(page)).toBeVisible();
  return terminal;
}

test("the page shows the bar itself, and Edit reveals the only place keys can be removed", async ({ page }) => {
  await openSettings(page);
  const names = await barNames(hero(page));
  // Command sits after Control on a Mac host and Shift does elsewhere; the bar's own order starts with Control either way.
  expect(names[0]).toBe("Control");
  expect(names).toContain("Escape");

  await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(0);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("button", { name: "Done", exact: true })).toBeVisible();
  const removeEscape = page.getByRole("button", { name: "Remove Escape" });
  await expect(removeEscape).toBeVisible();
  await removeEscape.click();
  await expect(page.locator('[data-edit-key="esc"]')).toHaveCount(0);
  await expect(page.locator('[data-restore-key="esc"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Add Escape" }).click();
  await expect(page.locator('[data-edit-key="esc"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const back = await barNames(hero(page));
  expect(back).toContain("Escape");
});

// The bar belongs to the host the phone talks to, not to the phone: this browser is an Android phone, whose own OS has
// no Command key, and the host under test is a Mac, so Command has to be on the bar. Keyed on the phone's OS it was not.
test.describe("an Android phone with a Mac host", () => {
  test.use({ userAgent: devices["Pixel 7"].userAgent, viewport: { width: 390, height: 844 } });

  test("shows the Command key its host has, not the keys its own OS would", async ({ page }) => {
    // The runner may be a Linux machine: name the host's OS so this asserts the host's keys, not the runner's.
    await fakeHostOs(page, "darwin");
    await openSettings(page);
    // The host's OS arrives over the connection after the page draws; until then the bar is the generic one.
    await expect.poll(() => barNames(hero(page)), { timeout: 10_000 }).toContain("Command");
    await page.getByRole("button", { name: /^Keys/ }).click();
    const picker = page.getByRole("dialog", { name: "Add keys" });
    await expect(picker.getByRole("button", { name: "Command" })).toBeVisible();
  });
});

test("the grip moves a key with the keyboard, so a drag is not the only way to reorder", async ({ page }) => {
  await openSettings(page);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const order = async (): Promise<readonly string[]> =>
    page.locator("[data-edit-key]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-edit-key") ?? ""));
  const before = await order();
  const at = before.indexOf("esc");
  expect(at).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Reorder Escape" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator('p[aria-live="polite"]')).toContainText("Escape picked up");
  await page.keyboard.press("ArrowUp");
  expect((await order()).indexOf("esc")).toBe(at - 1);
  await page.keyboard.press("Enter");
  await expect(page.locator('p[aria-live="polite"]')).toContainText(
    `Escape dropped at position ${at} of ${before.length}`,
  );
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const names = await barNames(hero(page));
  expect(names[at - 1]).toBe("Escape");
});

test("Escape puts a picked-up key back where it was", async ({ page }) => {
  await openSettings(page);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const order = async (): Promise<readonly string[]> =>
    page.locator("[data-edit-key]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-edit-key") ?? ""));
  const before = await order();
  const at = before.indexOf("esc");
  const grip = page.getByRole("button", { name: "Reorder Escape" });
  await grip.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowUp");
  await expect(grip).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator('p[aria-live="polite"]')).toContainText("Escape put down");
  expect((await order()).indexOf("esc")).toBe(at - 1);
  await page.keyboard.press("ArrowDown");
  expect((await order()).indexOf("esc")).toBe(at - 1);
});

test("a pack added from the Add keys sheet leads the hero and the terminal's bar", async ({ page }) => {
  await openSettings(page);
  await page.getByRole("button", { name: /^Keys/ }).click();
  const sheet = page.getByRole("dialog", { name: "Add keys" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Tmux", exact: true }).click();
  await expect(sheet.getByRole("button", { name: "Tmux", exact: true })).toHaveAttribute("aria-pressed", "true");
  await sheet.getByRole("button", { name: "Done", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  const names = await barNames(hero(page));
  expect(names.slice(0, 2)).toEqual(["Tmux prefix", "New window"]);

  await openTerminal(page);
  expect((await barNames(keysBar(page))).slice(0, 2)).toEqual(["Tmux prefix", "New window"]);
});

test("Edit's drag puts Escape ahead of Control in the bar", async ({ page }) => {
  await openSettings(page);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const moving = await page.locator('[data-edit-key="esc"]').boundingBox();
  const landing = await page.locator('[data-edit-key="ctrl"]').boundingBox();
  if (moving === null || landing === null) throw new Error("the edit rows were not drawn");
  await page.mouse.move(moving.x + moving.width - 20, moving.y + moving.height / 2);
  await page.mouse.down();
  await page.mouse.move(landing.x + landing.width - 20, landing.y - 6, { steps: 10 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const names = await barNames(hero(page));
  expect(names.indexOf("Escape")).toBeLessThan(names.indexOf("Control"));
});

test("a key of the person's own previews the bytes it sends, and the bar sends them", async ({ page }) => {
  await openSettings(page);
  await page.getByRole("button", { name: /^Your keys/ }).click();
  const sheet = page.getByRole("dialog", { name: "Your keys" });
  await sheet.getByLabel("Key label").fill("Where");
  await sheet.getByLabel("Keys it sends").fill("pwd");
  await expect(sheet.getByText("sends: pwd")).toBeVisible();
  await sheet.getByRole("button", { name: "Add key" }).click();
  await expect(sheet.locator("[data-custom-key]")).toHaveCount(1);
  await sheet.getByRole("button", { name: "Done", exact: true }).click();

  const terminal = await openTerminal(page);
  await page.getByRole("button", { name: "Where", exact: true }).click();
  // The text the key carries has to reach the terminal, not just the bar: the PTY echoes what it received.
  await expect(terminal).toContainText("pwd", { timeout: 10_000 });
});

test("an entry that names no key is refused with its reason and stored nowhere", async ({ page }) => {
  await openSettings(page);
  await page.getByRole("button", { name: /^Your keys/ }).click();
  const sheet = page.getByRole("dialog", { name: "Your keys" });
  await sheet.getByLabel("Key label").fill("Broken");
  await sheet.getByLabel("Keys it sends").fill("Ctrl+");
  await sheet.getByRole("button", { name: "Add key" }).click();
  await expect(sheet.getByText("End the key with what it presses, e.g. Ctrl+X.", { exact: true })).toBeVisible();
  await expect(sheet.locator("[data-custom-key]")).toHaveCount(0);
});

test("the Packs row toggles a pack off, and its keys leave the bar", async ({ page }) => {
  await openSettings(page);
  await page.getByRole("button", { name: /^Keys/ }).click();
  const picker = page.getByRole("dialog", { name: "Add keys" });
  await picker.getByRole("button", { name: "Tmux", exact: true }).click();
  await picker.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: /^Packs/ }).click();
  const packs = page.getByRole("dialog", { name: "Packs" });
  const toggle = packs.locator('[data-pack-row="tmux"]').getByRole("switch");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await packs.getByRole("button", { name: "Done", exact: true }).click();
  expect(await barNames(hero(page))).not.toContain("Tmux prefix");
});

for (const theme of ["day", "night"] as const) {
  test(`the bar and its keys stay readable in the ${theme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme === "day" ? "light" : "dark" });
    await page.addInitScript(
      (chosen: string) => localStorage.setItem("doriface.appearance", JSON.stringify({ theme: chosen, custom: [] })),
      theme,
    );
    await openSettings(page);
    const keys = hero(page).locator("button[aria-label]");
    await expect(keys.first()).toBeVisible();
    expect(await keys.count()).toBeGreaterThan(5);
    // A probe with the bar's own surface class: `bg-chrome/95` computes to oklab with an alpha, and a ratio against a
    // translucent colour would measure nothing.
    const surface = await keys.first().evaluate(() => {
      const probe = document.createElement("div");
      probe.className = "bg-chrome";
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    });
    expect(surface).toMatch(/^rgb\(/);
    const colors = await keys.evaluateAll((all) => all.map((key) => getComputedStyle(key).color));
    expect(Math.min(...colors.map((color) => ratio(color, surface)))).toBeGreaterThanOrEqual(4.5);
  });
}
