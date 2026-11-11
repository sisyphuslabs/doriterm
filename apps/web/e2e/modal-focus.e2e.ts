import type { Page, Route } from "@playwright/test";
import { setConfirmClose } from "./close-confirm.ts";
import { expect, openNewTerminal, terminalCount, test } from "./fixtures.ts";
import { pressShortcut } from "./platform-keys.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { hcOn } from "./machine-switch.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

/** Opens a terminal and returns its address; the shared fixture ends it after the test (terminal-guard.ts). */
const openOwnTerminal = async (page: Page): Promise<string> =>
  (await (await openNewTerminal(page)).getAttribute("data-terminal")) ?? "";

const focusInside = (page: Page, role: "dialog" | "menu", name?: RegExp) =>
  page.getByRole(role, name === undefined ? {} : { name }).evaluate((layer) => layer.contains(document.activeElement));

/** The address of the terminal whose input holds DOM focus, read from document.activeElement. */
const focusedAddress = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLTextAreaElement
      ? (active.closest("[data-terminal]")?.getAttribute("data-terminal") ?? null)
      : null;
  });

/** Holds the wasm core every view's renderer starts from, after a reload; release lets the renderers start. */
async function reloadWithRenderersHeld(page: Page): Promise<() => Promise<void>> {
  const held: Route[] = [];
  let releasing = false;
  await page.route("**/*.wasm", (route) => (releasing ? route.continue() : void held.push(route)));
  await page.reload();
  await terminalCount(page);
  await expect.poll(() => held.length).toBeGreaterThan(0);
  await expect(page.locator('[data-focused="true"] [data-terminal]')).toHaveCount(0);
  return async () => {
    releasing = true;
    await Promise.all(held.splice(0).map((route) => route.continue()));
  };
}

test("a terminal that becomes ready while Cmd+W's question is open leaves the question open with focus in it", async ({
  page,
}) => {
  const socket = await routeHcSocket(page);
  await setConfirmClose(page, "always");
  await openNewTerminal(page);
  // After a reload every view attaches again; held, the focused one stays connecting until release.
  const release = socket.hold("terminal.attach");
  await page.reload();
  const terminal = page.locator('[data-focused="true"] [data-terminal]');
  await expect(terminal).toHaveCount(1, { timeout: 15_000 });
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  // The view asks to attach once its renderer is up, so its input exists and the attach is in flight.
  await expect
    .poll(() => socket.sent().some((frame) => frame.includes('"method":"terminal.attach"') && frame.includes(address)))
    .toBe(true);
  await expect(terminal).not.toContainText("$");

  await terminal.locator("textarea").focus();
  await pressShortcut(page, "tab.close");
  const name = /^Close .+\?$/;
  const ask = page.getByRole("dialog", { name });
  await expect(ask).toBeVisible();
  await expect.poll(() => focusInside(page, "dialog", name)).toBe(true);

  release();
  // The prompt is drawn by the attached stream, so once it shows, the view has finished becoming ready.
  await expect(terminal).toContainText("$", { timeout: 15_000 });
  await expect(ask).toBeVisible();
  expect(await focusInside(page, "dialog", name)).toBe(true);

  // Esc still answers it: the tab stays and focus goes back to the terminal it was asked from.
  await page.keyboard.press("Escape");
  await expect(ask).toHaveCount(0);
  await expect(page.locator(`[data-terminal="${address}"]`)).toHaveCount(1);
  await expect.poll(() => focusedAddress(page)).toBe(address);
});

test("a terminal whose renderer starts while Cmd+W's question is open leaves the question open with focus in it", async ({
  page,
}) => {
  await setConfirmClose(page, "always");
  await openNewTerminal(page);
  const release = await reloadWithRenderersHeld(page);

  // Asked before any renderer started, so focus was on the page body when the question opened.
  await pressShortcut(page, "tab.close");
  const name = /^Close .+\?$/;
  const ask = page.getByRole("dialog", { name });
  await expect(ask).toBeVisible();
  await expect.poll(() => focusInside(page, "dialog", name)).toBe(true);

  await release();
  const terminal = page.locator('[data-focused="true"] [data-terminal]');
  await expect(terminal).toContainText("$", { timeout: 15_000 });
  await expect(ask).toBeVisible();
  expect(await focusInside(page, "dialog", name)).toBe(true);

  // Answered, the question gives focus to the focused pane's terminal, not back to the page body.
  await page.keyboard.press("Escape");
  await expect(ask).toHaveCount(0);
  await expect.poll(() => focusedAddress(page)).toBe(await terminal.getAttribute("data-terminal"));
});

test("the terminal left when Cmd+W's session ends under the question does not take focus from it", async ({ page }) => {
  const socket = await routeHcSocket(page);
  await setConfirmClose(page, "always");
  const remaining = await openOwnTerminal(page);
  const asked = await openOwnTerminal(page);
  await page.locator(`[data-terminal="${asked}"]`).getByRole("textbox").focus();
  await pressShortcut(page, "tab.close");
  const name = /^Close .+\?$/;
  const ask = page.getByRole("dialog", { name });
  await expect(ask).toBeVisible();
  await expect.poll(() => focusInside(page, "dialog", name)).toBe(true);

  // The feed's word that the session ended waits, so the question stays open while its tab goes and the remaining
  // terminal's pane becomes the focused one.
  const release = socket.holdFromHost(`"${asked}"`);
  hcOn("host", ["kill", asked]);
  await expect(page.locator(`[data-focused="true"] [data-terminal="${remaining}"]`)).toHaveCount(1, {
    timeout: 15_000,
  });
  // A later update from the core: React runs the pane's effects from becoming focused before it renders this one, so
  // once the new name shows, the pane has done whatever it does on becoming focused.
  hcOn("host", ["label", remaining, "herdr.name=after-the-tab-went"]);
  await expect(page.locator('[data-focused="true"]')).toHaveAttribute("aria-label", "after-the-tab-went terminal", {
    timeout: 15_000,
  });
  await expect(ask).toBeVisible();
  expect(await focusInside(page, "dialog", name)).toBe(true);

  release();
  hcOn("host", ["rm", asked]);
});

test("a press on a terminal that ends after Cmd+W's question opened leaves focus in the question", async ({ page }) => {
  await setConfirmClose(page, "always");
  const address = await openOwnTerminal(page);
  const box = await page.locator(`[data-terminal="${address}"]`).boundingBox();
  if (box === null) throw new Error(`${address} has no box`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // The question opens from the keyboard while the button is still down; the press then ends over it.
  await pressShortcut(page, "tab.close");
  const name = /^Close .+\?$/;
  const ask = page.getByRole("dialog", { name });
  await expect(ask).toBeVisible();
  await expect.poll(() => focusInside(page, "dialog", name)).toBe(true);

  await page.mouse.up();
  expect(await focusInside(page, "dialog", name)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(ask).toHaveCount(0);
});

test("a terminal whose renderer starts while its session menu is open leaves the menu open with focus in it", async ({
  page,
}) => {
  await page.goto("/");
  await openNewTerminal(page);
  const release = await reloadWithRenderersHeld(page);

  await page.getByRole("button", { name: /^Session actions for / }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect.poll(() => focusInside(page, "menu")).toBe(true);

  await release();
  await expect(page.locator('[data-focused="true"] [data-terminal]')).toContainText("$", { timeout: 15_000 });
  await expect(menu).toBeVisible();
  expect(await focusInside(page, "menu")).toBe(true);

  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});
