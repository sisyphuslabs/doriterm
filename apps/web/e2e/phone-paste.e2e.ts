import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { key, openPhoneTerminal, PHONE } from "./phone-key-bar.ts";
import { pointOn, pointOnLastText } from "./terminal-points.ts";
import { Touch } from "./touch.ts";

test.use({ serviceWorkers: "block", ...PHONE, permissions: ["clipboard-read", "clipboard-write"] });

const menu = (page: Page) => page.getByRole("menu", { name: "Selected text" });
const clipboard = (page: Page, text: string) => page.evaluate((value) => navigator.clipboard.writeText(value), text);

/** A finger that stays down this long is still holding on purpose, well past the moment a touch becomes a tap. */
const HELD_MS = 1_200;

/**
 * Holds a finger on the terminal's own text and pastes from the menu it opens. `heldMs` keeps the finger down that much
 * longer than the hold needs, as a person who reads the selection before lifting does (#760).
 */
async function pasteFromMenu(page: Page, at: string | null = null, heldMs = 0): Promise<void> {
  const terminal = page.locator("[data-terminal]");
  const point = at === null ? await pointOnLastText(terminal) : await pointOn(terminal, "$", at);
  const touch = await Touch.on(page);
  await touch.down(point);
  await expect(page.locator(".term-selection-cells > div").first()).toBeVisible();
  if (heldMs > 0) await page.waitForTimeout(heldMs);
  await touch.up(point);
  await menu(page).getByRole("menuitem", { name: "Paste" }).click();
}

test("the held touch's menu pastes Korean text into the line being typed", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  await clipboard(page, "안녕하세요");
  await pasteFromMenu(page, "$");
  await expect(terminal).toContainText("안녕하세요", { timeout: 15_000 });
});

test("a finger still down after the hold pastes from the menu its lift opens", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  await clipboard(page, "안녕하세요");
  await pasteFromMenu(page, "$", HELD_MS);
  await expect(terminal).toContainText("안녕하세요", { timeout: 15_000 });
});

test("a program that asked for bracketed paste gets its markers, and the lines do not run first", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  // The program turns bracketed paste on and reports what it read, with the escape byte written as @ so the terminal
  // paints the marker instead of taking it as a sequence.
  await page.keyboard.type(
    "printf '\\033[?2004h'; IFS= read -r line; printf 'GOT:%s\\n' \"$(printf '%s' \"$line\" | tr '\\033' '@')\"\r",
  );
  await expect(terminal).toContainText("read -r line", { timeout: 15_000 });
  await clipboard(page, "안녕하세요\n둘째 줄");
  await pasteFromMenu(page);

  await expect(terminal).toContainText("GOT:@[200~안녕하세요", { timeout: 15_000 });
  // Bracketed paste hands the whole block over at once: the second line is still the program's, not the shell's.
  await expect(terminal).not.toContainText("command not found");
});

test("the Paste key pastes Korean, and asks before several lines run a program that asked for none", async ({
  page,
}) => {
  const terminal = await openPhoneTerminal(page);
  await clipboard(page, "echo 한글-$((6*7))");
  await key(page, "Paste").click();
  await expect(terminal).toContainText("echo 한글-$((6*7))", { timeout: 15_000 });
  await page.keyboard.type("\r");
  await expect(terminal).toContainText("한글-42", { timeout: 15_000 });

  await clipboard(page, "echo one-$((1+1))\necho two-$((2+2))");
  await key(page, "Paste").click();
  const dialog = page.getByRole("dialog", { name: "Paste 2 lines?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Paste" }).click();
  await expect(terminal).toContainText("one-2", { timeout: 15_000 });
  // The pasted block keeps its own newlines; the line the paste left open is the one Enter submits.
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("two-4", { timeout: 15_000 });
});
