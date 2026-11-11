import { endAgent, startShell } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { key, openPhoneTerminal, PHONE } from "./phone-key-bar.ts";

test.use({ serviceWorkers: "block", ...PHONE });

let other: string | null = null;
let opened: string | null = null;
test.afterEach(() => {
  for (const address of [other, opened]) if (address !== null) endAgent("host", address);
  other = null;
  opened = null;
});

test("picking a different session in Switch session never focuses the terminal it leaves (#1985)", async ({ page }) => {
  other = startShell("host", "switch-focus-other");
  opened = await (await openPhoneTerminal(page)).getAttribute("data-terminal");
  await key(page, "Switch session").click();
  const menu = page.getByRole("menu");
  const item = menu.getByRole("menuitem").filter({ hasText: "switch-focus-other" });
  await expect(item).toBeVisible({ timeout: 15_000 });
  // Every focus from here on, by the terminal it lands in ("" for anything outside a terminal).
  await page.evaluate(() => {
    const seen: string[] = [];
    Object.assign(window, { focusSeen: seen });
    document.addEventListener(
      "focusin",
      (event) => {
        const target = event.target instanceof Element ? event.target : null;
        seen.push(target?.closest("[data-terminal]")?.getAttribute("data-terminal") ?? "");
      },
      true,
    );
  });
  await item.click();
  await expect(page.locator(`[data-terminal="${other}"]`)).toBeVisible({ timeout: 15_000 });
  const seen = await page.evaluate(() => (window as unknown as { focusSeen: string[] }).focusSeen);
  expect(seen).not.toContain(opened);
});

test.describe("with a mouse, where the keys bar stays open as the menu closes", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: false, isMobile: false });

  test("closing Switch session with no terminal field to focus gives the focus back to its button (#1986)", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("banner").getByRole("button", { name: "New tab" }).click();
    const terminal = page.locator("[data-terminal]");
    await expect(terminal).toContainText("$", { timeout: 15_000 });
    opened = await terminal.getAttribute("data-terminal");
    await key(page, "Show keys").click();
    await key(page, "Switch session").click();
    await expect(page.getByRole("menu")).toBeVisible();
    // A view whose terminal is not attached has no field to take the focus: a disabled field stands in for it.
    await terminal.locator("textarea").evaluate((field) => {
      if (field instanceof HTMLTextAreaElement) field.disabled = true;
    });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(key(page, "Switch session")).toBeFocused();
  });
});
