import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { fakeSoftKeyboard, key, keysBar, PHONE } from "./phone-key-bar.ts";

// A touch phone's keys are one panel whether the soft keyboard is up or down (#2499): the keys in one flat row that ends
// in the arrow keys and the keyboard's own toggle, the same structure, order and look in both states. The Type field
// with Send takes a row of its own above them only while the keyboard is up (#2604).
test.use({ serviceWorkers: "block", ...PHONE });

/** The keyboard's toggle at the row's end: Hide keyboard while it is up, Show keyboard while it is down. */
const TOGGLES = new Set(["Hide keyboard", "Show keyboard"]);

interface Panel {
  /** Every element under the key row's scroller, outside the icons' own drawing: its depth, tag, role and slot. */
  readonly structure: readonly string[];
  /** The panel's controls in document order, the toggle by its slot rather than its state's name. */
  readonly order: readonly string[];
  /** Each key's computed look, in the same order. */
  readonly styles: readonly string[];
  /** The Type row's field and Send: their computed look and drawn box. */
  readonly typeRow: readonly string[];
  /** The Type row is drawn above the key row: the field's and Send's bottoms against the key row's top. */
  readonly typeAbove: boolean;
  /** The key row's drawn size, rounded to the px. */
  readonly size: string;
}

async function panel(page: Page): Promise<Panel> {
  await expect(keysBar(page)).toBeVisible();
  return keysBar(page).evaluate(
    (bar, toggles) => {
      const name = (el: Element): string => {
        const label = el.getAttribute("aria-label") ?? "";
        return toggles.includes(label) ? "keyboard toggle" : label;
      };
      const structure: string[] = [];
      const walk = (el: Element, depth: number): void => {
        structure.push(
          `${depth} ${el.tagName.toLowerCase()} ${el.getAttribute("role") ?? ""} ${el.getAttribute("data-slot") ?? ""}`,
        );
        if (el.tagName.toLowerCase() === "svg") return;
        for (const child of el.children) walk(child, depth + 1);
      };
      const scroller = bar.querySelector("[data-slot=terminal-keys-scroll]");
      if (scroller !== null) walk(scroller, 0);
      const controls = [...bar.querySelectorAll("button, textarea, input")];
      const keys = [...bar.querySelectorAll("button")].filter((button) => button.ariaLabel !== "Send");
      const look = (el: Element): string => {
        const css = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        return [
          name(el),
          `${Math.round(box.width)}x${Math.round(box.height)}`,
          css.backgroundColor,
          css.color,
          css.borderTopWidth,
          css.borderTopColor,
          css.borderRadius,
          css.fontFamily,
          css.fontSize,
          css.fontWeight,
          css.paddingLeft,
          css.paddingRight,
          css.boxShadow,
        ].join(" | ");
      };
      const field = bar.querySelector("textarea");
      const send = [...bar.querySelectorAll("button")].find((button) => button.ariaLabel === "Send");
      const keysTop = bar.querySelector("[data-slot=terminal-keys-scroll]")?.getBoundingClientRect().top ?? 0;
      return {
        typeAbove: [field, send].every(
          (el) => el !== null && el !== undefined && el.getBoundingClientRect().bottom <= keysTop + 1,
        ),
        typeRow: [field, send].map((el) => (el === null || el === undefined ? "missing" : look(el))),
        structure,
        order: controls.map((el) => (el.tagName.toLowerCase() === "button" ? name(el) : el.tagName.toLowerCase())),
        styles: keys.map(look),
        size: (() => {
          const box = scroller?.getBoundingClientRect();
          return box === undefined ? "none" : `${Math.round(box.width)}x${Math.round(box.height)}`;
        })(),
      };
    },
    [...TOGGLES],
  );
}

test("at 390 the keys are one panel with the keyboard down and up, with no Type row in either (#2499, #2604)", async ({
  page,
}) => {
  await fakeSoftKeyboard(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("banner").getByRole("button", { name: "New tab" }).click();
  const terminal = page.locator("[data-terminal]");
  await expect(terminal).toContainText("$", { timeout: 15_000 });

  // Down: the panel sits under the terminal, over the tabs bar, its toggle raising the keyboard.
  await expect(keysBar(page).getByRole("button", { name: "Show keyboard", exact: true })).toBeVisible();
  await expect(key(page, "Hide keyboard")).toHaveCount(0);
  const down = await panel(page);
  const tabs = page.getByRole("navigation", { name: "Tabs in this space" });
  await expect(tabs).toBeVisible();
  const [screen, bar, below] = await Promise.all([
    terminal.boundingBox(),
    keysBar(page).boundingBox(),
    tabs.boundingBox(),
  ]);
  if (screen === null || bar === null || below === null) throw new Error("a box is missing");
  expect(screen.y + screen.height).toBeLessThanOrEqual(bar.y + 1);
  expect(bar.y + bar.height).toBeLessThanOrEqual(below.y + 1);

  // Down: no Type row, the keys alone, ending in the arrow keys and the toggle.
  expect(down.typeRow).toEqual(["missing", "missing"]);
  expect(down.order.slice(-4)).toEqual(["Arrow keys", "Switch session", "Chat", "keyboard toggle"]);

  // Up: the same keys ride on the keyboard, under the Type field and Send.
  await keysBar(page).getByRole("button", { name: "Show keyboard", exact: true }).click();
  await expect(keysBar(page).getByRole("button", { name: "Hide keyboard", exact: true })).toBeVisible();
  const up = await panel(page);
  expect(up.structure).toEqual(down.structure);
  expect(up.order).toEqual(down.order);
  expect(up.styles).toEqual(down.styles);
  expect(up.size).toEqual(down.size);
  expect(up.typeRow).toEqual(["missing", "missing"]);

  // Down again: only the keyboard went.
  await keysBar(page).getByRole("button", { name: "Hide keyboard", exact: true }).click();
  await expect(keysBar(page).getByRole("button", { name: "Show keyboard", exact: true })).toBeVisible();
  expect(await panel(page)).toEqual(down);
});
