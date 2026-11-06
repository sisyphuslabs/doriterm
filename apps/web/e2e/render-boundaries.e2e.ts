import type { Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

/** Makes the named region throw while it renders from the next load on (crash/crash-probe.ts), until `stopCrash`. */
async function crashOnLoad(page: Page, region: string): Promise<void> {
  await page.addInitScript((name) => {
    if (sessionStorage.getItem("e2e.crash.stopped") === null) Reflect.set(window, "__dorifaceCrash", name);
  }, region);
}

async function stopCrash(page: Page): Promise<void> {
  await page.evaluate(() => {
    sessionStorage.setItem("e2e.crash.stopped", "1");
    Reflect.deleteProperty(window, "__dorifaceCrash");
  });
}

test("a terminal view that throws says so in its pane, the sidebar keeps working, and Try again draws it", async ({
  page,
}) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const address = await terminal.getAttribute("data-terminal");
  expect(address).not.toBeNull();
  await crashOnLoad(page, `pane:${address}`);
  await page.reload();
  const notice = page.getByRole("alert").filter({ hasText: "This terminal could not be drawn" });
  await expect(notice).toBeVisible({ timeout: 20_000 });
  // The rest of the app is still there and answers.
  await page.getByRole("button", { name: "Command palette" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await stopCrash(page);
  await notice.getByRole("button", { name: "Try again" }).click();
  const back = page.locator(`[data-terminal="${address}"]`);
  await back.getByRole("textbox").focus();
  await page.keyboard.type("echo boundary-ok");
  await page.keyboard.press("Enter");
  await expect(back).toContainText(/boundary-ok[\s\S]*boundary-ok/, { timeout: 15_000 });
});

test("a sidebar that throws says so in the sidebar while the terminal keeps taking input", async ({ page }) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const address = await terminal.getAttribute("data-terminal");
  await crashOnLoad(page, "sidebar");
  await page.reload();
  const notice = page.getByRole("alert").filter({ hasText: "The sidebar could not be drawn" });
  await expect(notice).toBeVisible({ timeout: 20_000 });
  const pane = page.locator(`[data-terminal="${address}"]`);
  await pane.getByRole("textbox").focus();
  await page.keyboard.type("echo sidebar-down-ok");
  await page.keyboard.press("Enter");
  await expect(pane).toContainText(/sidebar-down-ok[\s\S]*sidebar-down-ok/, { timeout: 15_000 });
  await stopCrash(page);
  await notice.getByRole("button", { name: "Try again" }).click();
  await expect(notice).toBeHidden();
});

test.describe("with clipboard access", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("a region's notice copies its own details, as the crash screen does", async ({ page }) => {
    await page.goto("/");
    const terminal = await openNewTerminal(page);
    const address = await terminal.getAttribute("data-terminal");
    await crashOnLoad(page, `pane:${address}`);
    await page.reload();
    const notice = page.getByRole("alert").filter({ hasText: "This terminal could not be drawn" });
    await notice.getByRole("button", { name: "Copy details" }).click();
    await expect(notice.getByRole("button", { name: "Copied" })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain(`Error: crash probe: pane:${address}`);
    await stopCrash(page);
  });

  test("an error outside every region shows the crash screen; Copy details copies it and Reload brings the app back", async ({
    page,
  }) => {
    await crashOnLoad(page, "app");
    await page.goto("/");
    const screen = page.getByRole("main").filter({ hasText: "Doriterm stopped drawing" });
    await expect(screen).toBeVisible({ timeout: 20_000 });
    await expect(screen).toContainText("Your terminals keep running on the host.");
    await screen.getByRole("button", { name: "Copy details" }).click();
    await expect(screen.getByRole("button", { name: "Copied" })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain("Error: crash probe: app");
    expect(copied).toContain("Route: /");
    await stopCrash(page);
    await screen.getByRole("button", { name: "Reload" }).click();
    await expect(page.getByRole("button", { name: "Command palette" })).toBeVisible({ timeout: 20_000 });
  });
});

test("a refused copy opens the details already selected", async ({ page }) => {
  await crashOnLoad(page, "app");
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")) },
    });
  });
  await page.goto("/");
  const screen = page.getByRole("main").filter({ hasText: "Doriterm stopped drawing" });
  await screen.getByRole("button", { name: "Copy details" }).click();
  await expect(screen.getByText("Copying was refused: the details are selected below.")).toBeVisible();
  const details = screen.locator("details");
  await expect(details).toHaveAttribute("open", "");
  const selection = await page.evaluate(() => getSelection()?.toString() ?? "");
  expect(selection).toContain("Error: crash probe: app");
});

test("a screen that throws shows the crash screen inside the router, and Try again draws it again", async ({
  page,
}) => {
  await crashOnLoad(page, "settings");
  await page.goto("/settings");
  const screen = page.getByRole("main").filter({ hasText: "Doriterm stopped drawing" });
  await expect(screen).toBeVisible({ timeout: 20_000 });
  await stopCrash(page);
  await screen.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
});

test("a Settings section that throws says so in place, under the Settings screen that still draws", async ({
  page,
}) => {
  await crashOnLoad(page, "settings-section");
  await page.goto("/settings");
  const notice = page.getByRole("alert").filter({ hasText: "This section could not be drawn" });
  await expect(notice).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
});
