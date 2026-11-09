import type { Locator, Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { endAgent, startShell } from "./agents.ts";
import { expect, followSystemAppearance, test } from "./fixtures.ts";
import { hcOn } from "./machine-switch.ts";

const shape = (icon: Locator) =>
  icon.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const control = element.closest("button")?.getBoundingClientRect();
    return {
      width: box.width,
      height: box.height,
      x: box.x,
      y: box.y,
      offsetX: control === undefined ? null : box.x - control.x,
      offsetY: control === undefined ? null : box.y - control.y,
    };
  });

const drawing = (icon: Locator) =>
  icon.evaluate(async (element) => {
    const svg = element.querySelector("svg");
    if (svg !== null) {
      const box = svg.getBoundingClientRect();
      const ink = svg.getBBox();
      return { width: box.width, height: box.height, ink: [ink.x, ink.y, ink.width, ink.height] };
    }
    const url = /url\("([^"]+)"\)/.exec(getComputedStyle(element).maskImage)?.[1];
    if (url === undefined) throw new Error("The native pin mask is missing");
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Cannot measure the native symbol");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let left = canvas.width,
      top = canvas.height,
      right = -1,
      bottom = -1;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        if ((pixels[(y * canvas.width + x) * 4 + 3] ?? 0) === 0) continue;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
    if (right < left || bottom < top) throw new Error("The native pin is blank");
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      ink: [left, top, right - left + 1, bottom - top + 1],
    };
  });

async function keepsGlyphSize(page: Page, button: Locator): Promise<void> {
  const glyph = button.locator("svg").first();
  const idle = await shape(glyph);
  await button.hover();
  expect(await shape(glyph)).toEqual(idle);
  await page.mouse.down();
  try {
    await button.evaluate(async (element) => {
      element.getBoundingClientRect();
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    expect(await shape(glyph)).toEqual(idle);
  } finally {
    await page.mouse.move(800, 600);
    await page.mouse.up();
    await page.keyboard.press("Escape");
  }
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`a pinned agent's icon keeps its size and position through interaction (${colorScheme})`, async ({ page }) => {
    await followSystemAppearance(page);
    await page.emulateMedia({ colorScheme });
    const address = startShell("host", "pin-size-proof");
    try {
      hcOn("host", ["send", address, "printf '\\033[2J\\033[H\\033]7501;state=idle\\033\\\\Pin controls ready\\n'"]);
      await page.goto("/");
      const row = page.getByRole("button", { name: /pin-size-proof/ }).first();
      await expect(row).toBeVisible();
      await row.hover();
      await page.getByRole("button", { name: "Pin pin-size-proof to the top", exact: true }).click();
      await page.mouse.move(800, 600);
      const mark = page
        .locator('svg[aria-label="Pinned"]:visible')
        .or(page.locator('button[aria-label="Unpin pin-size-proof"] [data-pin-symbol]:visible'));
      await expect(mark).toBeVisible();
      const resting = await shape(mark);
      expect([resting.width, resting.height]).toEqual([20, 20]);
      const filledDrawing = await drawing(mark);
      const measurements = [{ state: "pinned-rest", ...resting }];
      const rowBefore = await row.boundingBox();
      await row.hover();
      const control = page.getByRole("button", { name: "Unpin pin-size-proof", exact: true });
      const icon = control.locator("[data-pin-symbol], svg").first();
      await expect(icon).toBeVisible();
      const hovered = await shape(icon);
      measurements.push({ state: "pinned-hover", ...hovered });
      expect(hovered).toEqual(resting);
      expect(await row.boundingBox()).toEqual(rowBefore);

      await row.focus();
      await page.keyboard.press("ArrowRight");
      await expect(control).toBeFocused();
      expect(await control.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
      const focused = await shape(icon);
      measurements.push({ state: "focus-visible", ...focused });
      expect(focused).toEqual(resting);
      await control.hover();
      await page.mouse.down();
      try {
        await control.evaluate(async (element) => {
          element.getBoundingClientRect();
          await Promise.all(element.getAnimations().map((animation) => animation.finished));
        });
        const pressed = await shape(icon);
        measurements.push({ state: "pressed", ...pressed });
        expect(pressed).toEqual(resting);
      } finally {
        await page.mouse.move(800, 600);
        await page.mouse.up();
      }
      await control.evaluate((element) => {
        if (!(element instanceof HTMLButtonElement)) throw new Error("Expected a pin button");
        element.disabled = true;
        element.setAttribute("data-disabled", "");
      });
      const disabled = await shape(icon);
      measurements.push({ state: "disabled", ...disabled });
      expect(disabled).toEqual(resting);
      await control.evaluate((element) => {
        if (!(element instanceof HTMLButtonElement)) throw new Error("Expected a pin button");
        element.disabled = false;
        element.removeAttribute("data-disabled");
      });
      await expect(page.locator("[data-terminal]")).toHaveAttribute("data-ready", "true");
      await expect(page.getByRole("status", { name: "Opening terminal" })).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath(`pin-states-${colorScheme}.png`) });
      await control.click();
      await row.hover();
      const unpinned = page.getByRole("button", { name: "Pin pin-size-proof to the top", exact: true });
      await expect(unpinned).toBeVisible();
      const outline = await shape(unpinned.locator("[data-pin-symbol], svg").first());
      expect(await drawing(unpinned.locator("[data-pin-symbol]"))).toEqual(filledDrawing);
      measurements.push({ state: "unpinned-hover", ...outline });
      expect({
        width: outline.width,
        height: outline.height,
        offsetX: outline.offsetX,
        offsetY: outline.offsetY,
      }).toEqual({ width: resting.width, height: resting.height, offsetX: resting.offsetX, offsetY: resting.offsetY });
      const geometryPath = test.info().outputPath(`pin-geometry-${colorScheme}.json`);
      await writeFile(geometryPath, JSON.stringify({ colorScheme, measurements, filledDrawing }, null, 2));
      await test.info().attach("pin-geometry", { path: geometryPath, contentType: "application/json" });
      await keepsGlyphSize(page, page.locator("[data-tab-close]"));
      await keepsGlyphSize(page, page.getByRole("button", { name: "New tab", exact: true }));
    } finally {
      endAgent("host", address);
    }
  });
}
