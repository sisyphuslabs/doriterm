import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { expectTouchTargets, fakeSoftKeyboard, key, keysBar, PHONE } from "./phone-key-bar.ts";

// A touch phone with its soft keyboard down: a row of the keys Settings > Keyboard picked sits under the terminal, and
// a press there sends its key without raising the keyboard (#1526).
test.use({ serviceWorkers: "block", ...PHONE });

const row = (page: Page) => page.getByRole("toolbar", { name: "Quick keys" });

async function openDown(page: Page, width: number) {
  await fakeSoftKeyboard(page);
  await page.setViewportSize({ width, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("banner").getByRole("button", { name: "New tab" }).click();
  const terminal = page.locator("[data-terminal]");
  await expect(terminal).toContainText("$", { timeout: 15_000 });
  return terminal;
}

for (const width of [390, 320]) {
  test(`at ${width}, with the keyboard down, the row's keys reach the program and the keyboard stays down`, async ({
    page,
  }) => {
    const terminal = await openDown(page, width);
    await expect(row(page)).toBeVisible();
    await expect(keysBar(page)).toHaveCount(0);
    await expectTouchTargets(row(page));

    // A press in the terminal takes the focus and raises nothing (#1375); the typed line starts cat -v.
    await terminal.click();
    await page.keyboard.type("cat -v");
    await page.keyboard.press("Enter");
    const input = page.locator("[data-terminal] textarea");
    await expect(input).toBeFocused();

    await row(page).getByRole("button", { name: "Escape", exact: true }).tap();
    await row(page).getByRole("button", { name: "Arrow up", exact: true }).tap();
    await page.keyboard.press("Enter");
    await expect(terminal).toContainText("^[^[[A", { timeout: 10_000 });
    await expect(input).toBeFocused();
    await expect(key(page, "Show keyboard")).toBeVisible();
    await expect(keysBar(page)).toHaveCount(0);

    // ^C ends cat: the shell prints its prompt again.
    await row(page).getByRole("button", { name: "Control C", exact: true }).tap();
    await page.keyboard.type("echo back-$((40+2))");
    await page.keyboard.press("Enter");
    await expect(terminal).toContainText("back-42", { timeout: 10_000 });

    // The terminal fits above the row, and the row inside the screen.
    const [screen, keys] = await Promise.all([terminal.boundingBox(), row(page).boundingBox()]);
    expect(screen).not.toBeNull();
    expect(keys).not.toBeNull();
    if (screen === null || keys === null) return;
    expect(screen.y + screen.height).toBeLessThanOrEqual(keys.y + 1);
    expect(keys.y + keys.height).toBeLessThanOrEqual(844);
  });
}

test("with the keyboard up the keys bar carries the keys, and Read-only hides the row", async ({ page }) => {
  await openDown(page, 390);
  await key(page, "Show keyboard").click();
  await expect(keysBar(page)).toBeVisible();
  await expect(row(page)).toHaveCount(0);
  await key(page, "Hide keyboard").click();
  await expect(row(page)).toBeVisible();

  await key(page, "Read-only").click();
  await expect(row(page)).toHaveCount(0);
  await key(page, "Read-only").click();
  await expect(row(page)).toBeVisible();
});
