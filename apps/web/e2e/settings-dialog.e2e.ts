import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { pickFile } from "./file-input";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, openNewTerminal, terminalCount, test } from "./fixtures.ts";
import { pressShortcut } from "./platform-keys.ts";
import { hcOn } from "./machine-switch.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const settingsDialog = (page: Page) => page.getByRole("dialog", { name: "Settings" });
const workspace = (page: Page) => page.locator('aside[aria-label="Workspace"]');
/** The full-screen sheet a phone shows Settings in; it is a dialog named Settings too, filling the window. */
const settingsSheet = (page: Page) => page.locator("[data-settings-sheet]");

/** The address of the terminal whose input holds DOM focus. */
const focusedTerminal = (page: Page) =>
  page.evaluate(() =>
    document.activeElement instanceof HTMLTextAreaElement
      ? (document.activeElement.closest("[data-terminal]")?.getAttribute("data-terminal") ?? null)
      : null,
  );

test.describe("on a wide screen", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("Settings opens as a dialog over a live terminal that keeps drawing its output, and Escape returns to it (#673)", async ({
    page,
  }) => {
    const gates = mkdtempSync(join(tmpdir(), "doriface-settings-dialog-"));
    try {
      await page.goto("/");
      const terminal = await openNewTerminal(page);
      const address = (await terminal.getAttribute("data-terminal")) ?? "";
      // The program prints each line only once its gate file exists, so a line drawn behind the dialog was printed
      // while the dialog was open.
      hcOn("host", [
        "send",
        address,
        `until [ -e ${gates}/1 ]; do sleep 0.05; done; echo behind-dialog-673; until [ -e ${gates}/2 ]; do sleep 0.05; done; echo after-dialog-673`,
      ]);
      await expect.poll(() => focusedTerminal(page)).toBe(address);

      await page.getByRole("link", { name: "Settings" }).click();
      await expect(page).toHaveURL(/\/settings$/);
      await expect(settingsDialog(page)).toBeVisible();
      // The workspace stays in view behind the dialog, and is inert: Tab cannot reach it.
      await expect(workspace(page)).toBeVisible();
      expect(await workspace(page).evaluate((aside) => aside.closest("[inert]") !== null)).toBe(true);
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null))
        .toBe(true);

      writeFileSync(join(gates, "1"), "");
      await expect(terminal.locator(".term-row").filter({ hasText: /^behind-dialog-673\s*$/ })).toBeVisible({
        timeout: 15_000,
      });

      // A display choice made in the dialog applies to the terminal behind it as it is made.
      const fontSize = () =>
        terminal.evaluate((el) => getComputedStyle(el).getPropertyValue("--term-font-size").trim());
      expect(await fontSize()).toBe("13pt");
      await settingsDialog(page).getByRole("button", { name: "Appearance", exact: true }).click();
      await settingsDialog(page).getByRole("button", { name: "Larger terminal text" }).click();
      await expect.poll(fontSize).toBe("14pt");
      await expect(settingsDialog(page).getByText("14 pt")).toBeVisible();

      await page.keyboard.press("Escape");
      await expect(page).toHaveURL(/\/$/);
      await expect(settingsDialog(page)).toHaveCount(0);
      await expect.poll(() => focusedTerminal(page)).toBe(address);
      writeFileSync(join(gates, "2"), "");
      await expect(terminal.locator(".term-row").filter({ hasText: /^after-dialog-673\s*$/ })).toBeVisible({
        timeout: 15_000,
      });
    } finally {
      rmSync(gates, { recursive: true, force: true });
    }
  });

  test("a click on the backdrop closes Settings, and a dialog opened inside it is not the Settings dialog (#673)", async ({
    page,
  }) => {
    await page.goto("/");
    await terminalCount(page);
    await page.getByRole("link", { name: "Settings" }).click();
    await expect(settingsDialog(page)).toBeVisible();
    // A dialog opened inside Settings takes Escape first: it closes alone, and Settings stays open.
    await settingsDialog(page).getByRole("button", { name: "Keybindings", exact: true }).click();
    await pickFile(page, "Import keybinds…", "keybinds", "keybind = super+t=new_tab\n");
    const inner = page.getByRole("dialog", { name: "Import these keybindings?" });
    await expect(inner).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(inner).toHaveCount(0);
    await expect(page).toHaveURL(/\/settings$/);
    await expect(settingsDialog(page)).toBeVisible();
    const box = await settingsDialog(page).boundingBox();
    if (box === null) throw new Error("the Settings dialog has no box");
    // Left of the panel, halfway down: the backdrop.
    await page.mouse.click(Math.max(4, box.x / 2), box.y + box.height / 2);
    await expect(page).toHaveURL(/\/$/);
    await expect(settingsDialog(page)).toHaveCount(0);
  });

  test("opened as the first screen, Settings keeps a titlebar band across the top that starts past the window buttons (#969)", async ({
    page,
  }) => {
    // The desktop shell's inset for its window buttons, as layout.e2e sets it.
    const inset = 78;
    await page.goto("/settings");
    await page.addStyleTag({ content: `:root { --titlebar-inset-start: ${inset}px; }` });
    await expect(settingsDialog(page)).toBeVisible();
    const bands = await page.evaluate(() =>
      [...document.querySelectorAll("[data-titlebar]")].flatMap((el) => {
        const box = el.getBoundingClientRect();
        if (!el.checkVisibility() || box.top > 1) return [];
        return [
          { left: box.left, right: box.right, start: box.left + Number.parseFloat(getComputedStyle(el).paddingLeft) },
        ];
      }),
    );
    const width = page.viewportSize()?.width ?? 0;
    // One band spans the window: the desktop app moves the window by it, whatever the workspace behind has drawn.
    expect(bands.some((band) => band.left <= 0 && band.right >= width && band.start >= inset)).toBe(true);
  });

  test("in a browser, a click on the backdrop's top band, under the titlebar strip, closes Settings too (#673)", async ({
    page,
  }) => {
    await page.goto("/");
    await terminalCount(page);
    await page.getByRole("link", { name: "Settings" }).click();
    await expect(settingsDialog(page)).toBeVisible();
    const box = await settingsDialog(page).boundingBox();
    if (box === null) throw new Error("the Settings dialog has no box");
    // Left of the panel, 10 px from the top: the band the desktop app moves the window by.
    await page.mouse.click(Math.max(4, box.x / 2), 10);
    await expect(page).toHaveURL(/\/$/);
    await expect(settingsDialog(page)).toHaveCount(0);
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("Settings is a full-screen sheet, with the workspace hidden under it (#673)", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible({ timeout: 15_000 });
    await expect(settingsSheet(page)).toBeVisible();
    await expect(settingsDialog(page)).toHaveAttribute("data-settings-sheet");
    expect(await settingsSheet(page).boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 });
    await expect(workspace(page)).toBeHidden();
  });

  test("opening Settings moves focus into the sheet, onto no action button (#1495)", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "This device", level: 2 }).first()).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const active = document.activeElement;
          return active !== null && active !== document.body && active.closest("[data-settings-sheet]") !== null;
        }),
      )
      .toBe(true);
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BUTTON");
  });
});

test.describe("Settings across the md breakpoint, and its zoom keys (#859)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the hinted text-size key steps the terminals' text while Settings is open in a browser", async ({ page }) => {
    await page.goto("/settings#appearance");
    const size = settingsDialog(page)
      .locator("output")
      .filter({ hasText: /\d+ pt$/ });
    await expect(size).toBeVisible({ timeout: 15_000 });
    const before = Number.parseFloat((await size.textContent()) ?? "");
    await pressShortcut(page, "app.zoom_in");
    await expect.poll(async () => Number.parseFloat((await size.textContent()) ?? "")).toBeGreaterThan(before);
    await pressShortcut(page, "app.zoom_out");
    await expect.poll(async () => Number.parseFloat((await size.textContent()) ?? "")).toBe(before);
  });

  test("a resize between dialog and sheet keeps the open section and a key recording under way", async ({ page }) => {
    await page.goto("/settings");
    await expect(settingsDialog(page)).toBeVisible({ timeout: 15_000 });
    await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Keybindings" }).click();
    await page
      .getByRole("button", { name: /^Record a shortcut for / })
      .first()
      .click();
    const recorder = page.locator("[data-captures-keys]");
    await expect(recorder).toBeFocused();

    await page.setViewportSize({ width: 700, height: 800 });
    await expect(settingsSheet(page)).toBeVisible();
    await expect(page.locator("[data-settings-dialog]")).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Keybindings", selected: true })).toBeVisible();
    await expect(recorder).toBeFocused();

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(settingsDialog(page)).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Keybindings" }),
    ).toHaveAttribute("aria-current", "page");
    await expect(recorder).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(recorder).toHaveCount(0);
  });

  test("a resize between dialog and sheet keeps the reader's place in the settings body (#1161)", async ({ page }) => {
    await page.goto("/settings#terminal");
    await expect(settingsDialog(page)).toBeVisible({ timeout: 15_000 });
    const body = page.locator('[data-slot="settings-body"]');
    await expect.poll(() => body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await body.evaluate((el) => {
      el.scrollTop = 600;
    });
    await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(600);

    await page.setViewportSize({ width: 700, height: 800 });
    await expect(settingsSheet(page)).toBeVisible();
    // The frame moves, and the reader stays where they were reading rather than at the first row of the section.
    await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(600);
  });

  test("a resize between dialog and sheet does not save a half-typed connection address (#1160)", async ({ page }) => {
    await page.goto("/settings");
    await expect(settingsDialog(page)).toBeVisible({ timeout: 15_000 });
    // The fixture's loopback link gives a release build the Gateway field, as on a developer's own machine.
    const gateway = page.getByRole("textbox", { name: "Gateway", exact: true });
    await expect(gateway).toBeVisible();
    const saved = (): Promise<string> =>
      page.evaluate(() => JSON.parse(localStorage.getItem("doriface.connection") ?? "null").loopbackUrl as string);
    const before = await saved();
    await gateway.fill("ws://127.0.0.1:1/half-typed");
    await expect(gateway).toBeFocused();

    await page.setViewportSize({ width: 700, height: 800 });
    await expect(settingsSheet(page)).toBeVisible();
    // Focus comes back to the field, and the draft stays in it: the move saves nothing the reader is still typing. These
    // two cases guard #1160; neither engine delivers a blur to the field's handler while its frame is out of the page.
    await expect(gateway).toBeFocused();
    await expect(gateway).toHaveValue("ws://127.0.0.1:1/half-typed");
    // Read once, not polled: a save from the move is written as the field loses its frame, before the sheet above showed,
    // and a poll that passes on its first read waits for nothing (#1889).
    expect(await saved()).toBe(before);
  });

  test("a resize between dialog and sheet does not save a half-typed terminal value (#1160)", async ({ page }) => {
    await page.goto("/settings#terminal");
    await expect(settingsDialog(page)).toBeVisible({ timeout: 15_000 });
    const field = page.getByRole("textbox", { name: "adjust-cell-height" });
    // Committing shows the row's Reset button; a draft still being typed leaves it hidden.
    const reset = page.locator('button[aria-label="Reset adjust-cell-height"]');
    await field.fill("4");
    await expect(field).toBeFocused();
    await expect(reset).toBeHidden();

    await page.setViewportSize({ width: 700, height: 800 });
    await expect(settingsSheet(page)).toBeVisible();
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("4");
    await expect(reset).toBeHidden();
  });
});
