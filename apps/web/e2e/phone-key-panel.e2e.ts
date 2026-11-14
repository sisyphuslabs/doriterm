import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { fakeSoftKeyboard, key, keysBar, openPhoneTerminal, PHONE } from "./phone-key-bar.ts";

// A touch phone's keys are one panel whether the soft keyboard is up or down (#2499): the Type field with Send in a row
// of its own, then the keys in one flat row that ends in the keyboard's own toggle. Putting the keyboard down only puts
// the keyboard down; the panel keeps its structure, its keys' order and their look.
test.use({ serviceWorkers: "block", ...PHONE });

/** The keyboard's toggle at the row's end: Hide keyboard while it is up, Show keyboard while it is down. */
const TOGGLES = new Set(["Hide keyboard", "Show keyboard"]);

interface Panel {
  /** Every element under the panel, outside the icons' own drawing: its depth, tag, role and slot. */
  readonly structure: readonly string[];
  /** The panel's controls in document order, the toggle by its slot rather than its state's name. */
  readonly order: readonly string[];
  /** Each key's computed look, in the same order. */
  readonly styles: readonly string[];
  /** The Type row's field and Send: their computed look and drawn box. */
  readonly typeRow: readonly string[];
  /** The Type row is drawn above the key row: the field's and Send's bottoms against the key row's top. */
  readonly typeAbove: boolean;
  /** The panel's and the key row's drawn size, rounded to the px. */
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
      walk(bar, 0);
      const controls = [...bar.querySelectorAll("button, textarea, input")];
      const keys = [...bar.querySelectorAll("[data-slot=terminal-keys-scroll] button")];
      const toggle = [...bar.querySelectorAll("button")].find((button) => toggles.includes(button.ariaLabel ?? ""));
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
        styles: [...keys, ...(toggle === undefined ? [] : [toggle])].map(look),
        size: [bar, bar.querySelector("[data-slot=terminal-keys-scroll]")]
          .map((el) => {
            const box = el?.getBoundingClientRect();
            return box === undefined ? "none" : `${Math.round(box.width)}x${Math.round(box.height)}`;
          })
          .join(", "),
      };
    },
    [...TOGGLES],
  );
}

test("at 390 the keys are one panel with the keyboard down and up: the same structure, order and look (#2499)", async ({
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

  // Up: the same panel rides on the keyboard.
  await keysBar(page).getByRole("button", { name: "Show keyboard", exact: true }).click();
  await expect(keysBar(page).getByRole("button", { name: "Hide keyboard", exact: true })).toBeVisible();
  const up = await panel(page);
  expect(up.structure).toEqual(down.structure);
  expect(up.order).toEqual(down.order);
  expect(up.styles).toEqual(down.styles);
  expect(up.typeRow).toEqual(down.typeRow);
  expect(up.size).toEqual(down.size);
  // The Type field and Send across the top, the keys under them, the toggle last.
  expect(down.typeAbove).toBe(true);
  expect(up.order).toEqual(expect.arrayContaining(["textarea", "Send"]));
  expect(up.order.at(-1)).toBe("keyboard toggle");

  // Down again: only the keyboard went.
  await keysBar(page).getByRole("button", { name: "Hide keyboard", exact: true }).click();
  await expect(keysBar(page).getByRole("button", { name: "Show keyboard", exact: true })).toBeVisible();
  expect(await panel(page)).toEqual(down);
});

for (const motion of ["no-preference", "reduce"] as const) {
  test(`at 390 the riding panel eases as the keyboard moves, unless motion is reduced (${motion}, #2539)`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: motion });
    await openPhoneTerminal(page);
    await expect(key(page, "Hide keyboard")).toBeVisible();
    // The element that carries the panel's `bottom` is the one that has to transition it.
    const carrier = await keysBar(page).evaluate((bar) => {
      let el: Element | null = bar;
      while (el !== null && !(el instanceof HTMLElement && el.style.bottom !== "")) el = el.parentElement;
      if (el === null) return null;
      const css = getComputedStyle(el);
      return { property: css.transitionProperty, duration: css.transitionDuration };
    });
    expect(carrier, "an element carries the riding panel's bottom").not.toBeNull();
    if (motion === "reduce") expect(carrier?.duration).toBe("0s");
    else {
      expect(carrier?.property).toBe("bottom");
      expect(carrier?.duration).not.toBe("0s");
    }
  });
}
