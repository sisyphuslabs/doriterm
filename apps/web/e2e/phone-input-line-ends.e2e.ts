import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { key, openPhoneTerminal, PHONE } from "./phone-key-bar.ts";

test.use({ serviceWorkers: "block", ...PHONE });

const field = (page: Page) =>
  page.getByRole("group", { name: "Input card", exact: true }).getByLabel("Type into the terminal");

async function openInputCard(page: Page): Promise<void> {
  await key(page, "Type in a field").click();
  await expect(field(page)).toBeFocused();
}

// #2870: the card's Enter ends the line once. Line breaks at the end of the field are not sent as Returns of their own, which
// would answer the next prompt. Two reads tell the lines apart: an extra Return fills the second read with nothing.
test("a field of only a line break presses Return once", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  await openInputCard(page);
  await page.keyboard.type('read -r a; read -r b; echo "A=[$a] B=[$b]"');
  await key(page, "Send").click();
  await page.keyboard.press("Enter");
  await expect(field(page)).toHaveValue("\n");
  await key(page, "Send").click();
  await page.keyboard.type("second");
  await key(page, "Send").click();
  await expect(terminal).toContainText("A=[] B=[second]", { timeout: 15_000 });
});

test("a line with a line break after it is sent once, with no empty line after it", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  await openInputCard(page);
  await page.keyboard.type('read -r a; read -r b; echo "A=[$a] B=[$b]"');
  await key(page, "Send").click();
  await page.keyboard.type("first");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(field(page)).toHaveValue("first\n\n");
  await key(page, "Send").click();
  await page.keyboard.type("second");
  await key(page, "Send").click();
  await expect(terminal).toContainText("A=[first] B=[second]", { timeout: 15_000 });
});
