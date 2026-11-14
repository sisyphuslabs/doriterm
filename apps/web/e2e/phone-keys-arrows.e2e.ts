import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { key, keysBar, openPhoneTerminal, PHONE } from "./phone-key-bar.ts";

// On a phone the keys panel types into the terminal in two ways (#2604): the Type field with Send, there only while the
// soft keyboard is up, and the arrow keys, fixed beside the keyboard's own toggle whether the keyboard is up or down, so
// they never scroll out of reach with the rest of the keys.
test.use({ serviceWorkers: "block", ...PHONE });

const ARROWS = ["Left arrow", "Up arrow", "Down arrow", "Right arrow"];

/** The panel's fixed end: the controls after the scrolling keys, in order, and whether the Type row is there. */
const fixedEnd = (page: Page) =>
  keysBar(page).evaluate((bar) => {
    const scroller = bar.querySelector("[data-slot=terminal-keys-scroll]");
    const outside = [...bar.querySelectorAll("button")].filter((button) => !scroller?.contains(button));
    return {
      fixed: outside.map((button) => button.getAttribute("aria-label") ?? "").filter((label) => label !== "Send"),
      typeRow: bar.querySelector("textarea") !== null,
    };
  });

test("at 390 the Type row shows only with the keyboard up, and the arrow keys sit beside its toggle either way (#2604)", async ({
  page,
}) => {
  const terminal = await openPhoneTerminal(page);
  expect(await fixedEnd(page)).toEqual({ fixed: [...ARROWS, "Hide keyboard"], typeRow: true });

  // cat -v prints the arrows' bytes once the line ends; Return from the pad ends it.
  await page.keyboard.type("cat -v\r");
  await key(page, "Up arrow").click();
  await key(page, "Left arrow").click();
  // An arrow key keeps the text focus, so the keyboard stays up.
  await expect(key(page, "Hide keyboard")).toBeVisible();

  await key(page, "Hide keyboard").click();
  await expect(key(page, "Show keyboard")).toBeVisible();
  expect(await fixedEnd(page)).toEqual({ fixed: [...ARROWS, "Show keyboard"], typeRow: false });
  await key(page, "Down arrow").click();
  await key(page, "Right arrow").click();
  await key(page, "Arrow keys").click();
  await key(page, "Return").click();
  await expect(terminal).toContainText("^[[A^[[D^[[B^[[C", { timeout: 10_000 });
});
