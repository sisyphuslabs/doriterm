import type { Page } from "@playwright/test";
import { endAgent, startShell } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { fakeSoftKeyboard, key, keysBar, PHONE } from "./phone-key-bar.ts";

// A phone raises its soft keyboard only for a focus made inside the tap itself: a focus a frame later, or one that
// lands after the tap's task has ended, leaves the keyboard down. So each check reads the focus in the same task as the
// tap's click, after the app's own handlers have run, not after Playwright's next round trip.
test.use({ serviceWorkers: "block", ...PHONE });

interface Focus {
  readonly terminal: boolean;
  readonly inputMode: string;
  readonly readOnly: boolean;
  readonly disabled: boolean;
}

/** Records the focus as each click's task ends: a document listener runs after React's own on the root. */
async function recordFocusAfterTaps(page: Page, { buttonsTakeFocus }: { buttonsTakeFocus: boolean }): Promise<void> {
  await page.addInitScript((takeFocus) => {
    const seen: Focus[] = [];
    Object.assign(window, { focusAfterTaps: seen });
    // iOS Safari moves no focus to a tapped button; Chrome on Android does.
    if (!takeFocus) {
      document.addEventListener(
        "mousedown",
        (event) => {
          if (event.target instanceof Element && event.target.closest("button") !== null) event.preventDefault();
        },
        true,
      );
    }
    document.addEventListener("click", () => {
      const active = document.activeElement;
      const field = active instanceof HTMLTextAreaElement ? active : null;
      seen.push({
        terminal: field !== null && field.closest("[data-terminal]") !== null,
        inputMode: field?.inputMode ?? "",
        readOnly: field?.readOnly ?? false,
        disabled: field?.disabled ?? false,
      });
    });
  }, buttonsTakeFocus);
}

const lastFocus = (page: Page): Promise<Focus | undefined> =>
  page.evaluate(() => (Reflect.get(window, "focusAfterTaps") as Focus[]).at(-1));

const RAISED: Focus = { terminal: true, inputMode: "text", readOnly: false, disabled: false };

async function openTerminal(page: Page, name: RegExp): Promise<void> {
  await page.goto("/");
  const row = page.getByRole("button", { name }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(page.locator("[data-terminal]")).toContainText("$", { timeout: 15_000 });
}

for (const buttonsTakeFocus of [true, false]) {
  const engine = buttonsTakeFocus ? "a button takes the focus (Android)" : "a button takes no focus (iOS)";

  test(`${engine}: a tap on the terminal, then the keyboard button, raises the keyboard in that tap`, async ({
    page,
  }) => {
    const shell = startShell("host", "kbdtap");
    try {
      await fakeSoftKeyboard(page);
      await recordFocusAfterTaps(page, { buttonsTakeFocus });
      await openTerminal(page, /kbdtap/);
      const box = await page.locator("[data-terminal]").boundingBox();
      if (box === null) throw new Error("the terminal is not laid out");
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      // The tap focuses the terminal without asking for a keyboard (#1375).
      expect(await lastFocus(page)).toEqual({ ...RAISED, inputMode: "none" });

      await key(page, "Show keyboard").tap();
      expect(await lastFocus(page)).toEqual(RAISED);
      await expect(keysBar(page)).toBeVisible();

      // Put down and asked for again: the second ask raises it the same way.
      await key(page, "Hide keyboard").tap();
      await expect(key(page, "Show keyboard")).toBeVisible();
      await key(page, "Show keyboard").tap();
      expect(await lastFocus(page)).toEqual(RAISED);
    } finally {
      endAgent("host", shell);
    }
  });
}

test("closing Switch session gives the terminal the focus inside the closing tap, so the keyboard stays up", async ({
  page,
}) => {
  const shell = startShell("host", "kbdmenu");
  try {
    await fakeSoftKeyboard(page);
    await recordFocusAfterTaps(page, { buttonsTakeFocus: true });
    await openTerminal(page, /kbdmenu/);
    await key(page, "Show keyboard").tap();
    await expect(keysBar(page)).toBeVisible();

    await key(page, "Switch session").tap();
    const current = page.getByRole("menu").locator('[role="menuitem"][aria-current="true"]');
    await current.tap();
    await expect(page.getByRole("menu")).toHaveCount(0);
    expect(await lastFocus(page)).toEqual(RAISED);
    await expect(keysBar(page)).toBeVisible();
  } finally {
    endAgent("host", shell);
  }
});

test("the keyboard stays down under the keys until the keyboard button is tapped, which raises it focused with the Type field", async ({
  page,
}) => {
  const shell = startShell("host", "kbdfresh");
  try {
    await fakeSoftKeyboard(page);
    await recordFocusAfterTaps(page, { buttonsTakeFocus: true });
    await openTerminal(page, /kbdfresh/);
    const field = page.getByLabel("Type into the terminal");
    // The panel is there with the keyboard down (#2499), without its Type field (#2604).
    await expect(keysBar(page)).toBeVisible();
    await expect(field).toHaveCount(0);
    await expect(key(page, "Hide keyboard")).toHaveCount(0);
    await expect(page.locator("[data-terminal] textarea")).not.toBeFocused();

    await key(page, "Show keyboard").tap();
    expect(await lastFocus(page)).toEqual(RAISED);
    await expect(keysBar(page)).toBeVisible();
    await expect(field).toBeVisible();
  } finally {
    endAgent("host", shell);
  }
});

test("a session picked from Switch session opens with the keyboard down: only the keyboard button raises it", async ({
  page,
}) => {
  const first = startShell("host", "kbdone");
  const second = startShell("host", "kbdtwo");
  try {
    await fakeSoftKeyboard(page);
    await openTerminal(page, /kbdone/);
    await key(page, "Show keyboard").tap();
    await expect(keysBar(page)).toBeVisible();

    await key(page, "Switch session").tap();
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: /kbdtwo/ })
      .tap();
    const picked = page.locator(`[data-terminal="${second}"]`);
    await expect(picked).toContainText("$", { timeout: 15_000 });
    await expect(key(page, "Show keyboard")).toBeVisible();
    await expect(key(page, "Hide keyboard")).toHaveCount(0);
    await expect(picked.locator("textarea")).not.toBeFocused();
  } finally {
    endAgent("host", first);
    endAgent("host", second);
  }
});
