import type { Page } from "@playwright/test";
import { pickFile } from "./file-input";
import { expect, terminalCount, test } from "./fixtures.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const AIR_VIEWPORTS = [
  { width: 1470, height: 956 },
  { width: 1280, height: 800 },
] as const;

/** The close shortcut that exits Settings: Close pane on macOS, Close tab elsewhere. */
const CLOSE_TAB = process.platform === "darwin" ? "Meta+KeyW" : "Control+Shift+KeyW";
const SETTINGS = "ControlOrMeta+Comma";

/** Opens Settings from the workspace the way a person does, so there is a view to return to. */
async function openSettings(page: Page, section?: string): Promise<void> {
  await page.goto("/");
  await terminalCount(page);
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  if (section !== undefined) await page.getByRole("button", { name: section, exact: true }).click();
}

async function expectWorkspace(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("complementary", { name: "Workspace" })).toBeVisible();
}

async function openImportDialog(page: Page) {
  await pickFile(page, "Import keybinds…", "keybinds", "keybind = super+t=new_tab\n");
  const dialog = page.getByRole("dialog", { name: "Import these keybindings?" });
  await expect(dialog).toBeVisible();
  return dialog;
}

const closeControl = (page: Page) => page.getByRole("button", { name: "Close settings" }).first();

for (const viewport of AIR_VIEWPORTS) {
  test.describe(`at ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, deviceScaleFactor: 2 });

    test("Escape closes Settings and returns to the workspace", async ({ page }) => {
      await openSettings(page);
      await page.keyboard.press("Escape");
      await expectWorkspace(page);
    });

    test("the settings shortcut toggles Settings closed", async ({ page }) => {
      await openSettings(page);
      await page.keyboard.press(SETTINGS);
      await expectWorkspace(page);
    });

    test("the close-tab shortcut closes Settings", async ({ page }) => {
      await openSettings(page);
      await page.keyboard.press(CLOSE_TAB);
      await expectWorkspace(page);
    });

    for (const key of ["Escape", CLOSE_TAB, SETTINGS]) {
      test(`${key} closes an open dialog's layer first and never Settings under it`, async ({ page }) => {
        await openSettings(page, "Keybindings");
        const dialog = await openImportDialog(page);
        await page.keyboard.press(key);
        await expect(page).toHaveURL(/\/settings$/);
        if (key === "Escape") await expect(dialog).toBeHidden();
        else await expect(dialog).toBeVisible();
        if (key !== "Escape") await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        await page.keyboard.press("Escape");
        await expectWorkspace(page);
      });
    }

    test("Escape cancels a shortcut recording first, then closes Settings", async ({ page }) => {
      await openSettings(page, "Keybindings");
      await page.getByRole("button", { name: "Record a shortcut for New tab" }).click();
      await expect(page.getByRole("status")).toHaveText("Press keys…");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("status")).toBeHidden();
      await expect(page).toHaveURL(/\/settings$/);
      await expect(page.getByText("Changed")).toBeHidden();
      await page.keyboard.press("Escape");
      await expectWorkspace(page);
    });

    for (const [key, owner] of [
      [CLOSE_TAB, process.platform === "darwin" ? "Close pane" : "Close tab"],
      [SETTINGS, "Open settings"],
    ] as const) {
      test(`a recording takes ${key} as the new shortcut instead of leaving Settings`, async ({ page }) => {
        await openSettings(page, "Keybindings");
        await page.getByRole("button", { name: "Record a shortcut for New tab" }).click();
        await expect(page.getByRole("status")).toHaveText("Press keys…");
        await page.keyboard.press(key);
        await expect(page).toHaveURL(/\/settings$/);
        await expect(page.getByText(`is ${owner}.`)).toBeVisible();
        await expect(page.getByRole("button", { name: "Replace" })).toBeVisible();
      });
    }

    test("Escape in a search field with text clears it first, then closes Settings", async ({ page }) => {
      await openSettings(page, "Terminal");
      const search = page.getByRole("searchbox", { name: "Search terminal settings" });
      await search.fill("cursor");
      await page.keyboard.press("Escape");
      await expect(search).toHaveValue("");
      await expect(page).toHaveURL(/\/settings$/);
      await page.keyboard.press("Escape");
      await expectWorkspace(page);
    });

    test("the close control starts past the window-button inset and names its shortcut", async ({ page }) => {
      // The desktop shell sets this variable under its hidden-inset titlebar; any value proves the control follows it.
      await page.addInitScript(() => {
        document.addEventListener("DOMContentLoaded", () => {
          const style = document.createElement("style");
          style.textContent = ":root { --titlebar-inset-start: 91px; }";
          document.head.append(style);
        });
      });
      await page.goto("/settings");
      const control = closeControl(page);
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box?.x ?? 0).toBeGreaterThanOrEqual(91);
      await control.hover();
      await expect(page.getByText(/^Close settings\s*Esc$/)).toBeVisible();
      await control.click();
      await expect(page).toHaveURL(/\/$/);
    });
  });
}
