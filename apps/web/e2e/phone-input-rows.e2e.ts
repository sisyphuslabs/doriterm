import type { Page } from "@playwright/test";
import { KEYS_BAR_HEIGHT } from "../src/workspace/phone-keys.tsx";
import { expect, test } from "./fixtures.ts";
import { chatComposer, expectTouchTargets, key, keysBar, openChat, openPhoneTerminal, PHONE } from "./phone-key-bar.ts";

// The keys are one row (#2604); Chat swaps them for a composer whose field spans the width with Send at its end (#1551).
// Enter is one of the default keys.
test.use({ serviceWorkers: "block", ...PHONE });

const field = (page: Page) => chatComposer(page).getByRole("textbox");

for (const width of [390, 320]) {
  test(`at ${width} Chat's field and Send span the composer, above the terminal's bottom`, async ({ page }) => {
    const terminal = await openPhoneTerminal(page, width);
    await openChat(page);
    const bar = chatComposer(page);
    await expect(bar).toBeVisible();
    await expectTouchTargets(bar);
    const [box, input, send] = await Promise.all([
      bar.boundingBox(),
      field(page).boundingBox(),
      key(page, "Send").boundingBox(),
    ]);
    if (box === null || input === null || send === null) throw new Error("no box");
    // The field and Send share one row, and the field takes most of the composer's width.
    expect(Math.abs(input.y + input.height / 2 - (send.y + send.height / 2))).toBeLessThanOrEqual(2);
    expect(input.width).toBeGreaterThan(box.width * 0.6);
    const screen = await terminal.boundingBox();
    if (screen === null) throw new Error("no terminal box");
    expect(screen.y + screen.height).toBeLessThanOrEqual(box.y + 1);
  });
}

test("the height the terminal keeps clear before the bar reports its own is the one-row bar's (#1555, #2604)", async ({
  page,
}) => {
  await openPhoneTerminal(page);
  const bar = keysBar(page);
  await expect(bar).toBeVisible();
  const box = await bar.boundingBox();
  if (box === null) throw new Error("no bar box");
  const rem = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize));
  expect(box.height).toBeCloseTo(Number.parseFloat(KEYS_BAR_HEIGHT) * rem, 0);
});

test("Enter from the key row ends the line the program reads", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  await page.keyboard.type("echo row-return-$((20+22))");
  await keysBar(page).getByRole("button", { name: "Enter", exact: true }).click();
  await expect(terminal).toContainText("row-return-42", { timeout: 10_000 });
});
