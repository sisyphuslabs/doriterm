import { devices } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { fakeSoftKeyboard, key } from "./phone-key-bar.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

test("a bound key pressed during a blip reaches the shell in order with the typing around it", async ({ page }) => {
  // The macOS keymap binds Alt+Backspace to delete-word; pinning it keeps the key bound on every CI host.
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" }));
  const socket = await routeHcSocket(page);
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type("echo blip-$((1+2)) WRONG");
  await expect(terminal).toContainText("blip-$((1+2)) WRONG");

  await socket.drop(true);
  await expect(page.getByRole("status").filter({ hasText: "Reconnecting" })).toBeVisible();
  await page.keyboard.press("Alt+Backspace");
  await page.keyboard.type("right-$((2+2))");
  await page.keyboard.press("Enter");
  socket.restore();

  // Dropping the delete-word while replaying the typing around it would run `echo blip-3 WRONGright-4`.
  await expect(terminal).toContainText("blip-3 right-4", { timeout: 15_000 });
  expect(await terminal.textContent()).not.toContain("WRONGright");
});

test.describe("on a phone", () => {
  const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
  test.use(phone);

  test("an extra key pressed during a blip reaches the shell in order with the typing around it", async ({ page }) => {
    const socket = await routeHcSocket(page);
    // The keys bar shows on a touch phone only while the soft keyboard is up.
    await fakeSoftKeyboard(page);
    await page.goto("/");
    await page.getByRole("banner").getByRole("button", { name: "New tab" }).click();
    const terminal = page.locator("[data-terminal]");
    await expect(terminal).toContainText("$", { timeout: 15_000 });
    const input = terminal.getByRole("textbox");
    // Opening a terminal leaves the keyboard down, so the arrow pad is the keyboard button's to bring up (#1375).
    await key(page, "Show keyboard").click();

    await socket.drop(true);
    await expect.poll(socket.refused, { timeout: 15_000 }).toBeGreaterThan(0);
    await page.keyboard.type("echo pk-ab");
    await page.getByRole("button", { name: "Arrow keys" }).click();
    await page.getByRole("group", { name: "Arrow keys" }).getByRole("button", { name: "Left arrow" }).click();
    await input.focus();
    await page.keyboard.type("Z");
    await page.keyboard.press("Enter");
    socket.restore();

    // In order, Z replaces or precedes b: "pk-aZb" with line editing, "pk-aZ" where the shell echoes the arrow raw.
    // Dropped or replayed after Z, the arrow leaves "pk-abZ" either way.
    await expect(terminal).toContainText("pk-aZ", { timeout: 15_000 });
    expect(await terminal.textContent()).not.toContain("pk-abZ");
  });
});
