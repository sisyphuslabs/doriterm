import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { key, openPhoneTerminal, PHONE } from "./phone-key-bar.ts";

test.use({ serviceWorkers: "block", ...PHONE });

/**
 * Starts or updates a composition in the focused field through Blink's own input-method path, as a Korean keyboard does
 * while a syllable is still being typed: the text sits in the terminal's field as a preedit and nothing is sent yet.
 */
async function compose(page: Page, text: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
  await cdp.detach();
}

// The shell (dash on Linux) reads one line and prints its bytes in hex, so the order the program read is visible.
const READ_LINE = "IFS= read -r l; printf '%s' \"$l\" | od -An -tx1\r";
const HAN = "ed 95 9c";

async function pressReturn(page: Page): Promise<void> {
  await key(page, "Arrow keys").click();
  await key(page, "Return").click();
}

async function openReader(page: Page): Promise<Locator> {
  const terminal = await openPhoneTerminal(page);
  await page.keyboard.type(READ_LINE);
  return terminal;
}

test("a key-bar key tapped while a syllable composes sends the syllable first, once (#652)", async ({ page }) => {
  const terminal = await openReader(page);
  const field = terminal.getByRole("textbox");
  await compose(page, "한");
  await expect(field).toHaveValue("한");

  await key(page, "Escape").click();
  await expect(field).not.toHaveValue("한");
  // WebKit still reports the end of a composition the page took; it must not send the syllable a second time.
  await field.evaluate((el) => el.dispatchEvent(new CompositionEvent("compositionend", { data: "한", bubbles: true })));
  await pressReturn(page);
  await expect(terminal).toContainText(`${HAN} 1b`, { timeout: 10_000 });
  await expect(terminal).not.toContainText(`1b ${HAN}`);
  await expect(terminal).not.toContainText(`${HAN} ${HAN}`);
});

test("a latched ctrl reads a jamo still composing as its key: ctrl then ㅊ interrupts (#652)", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  await page.keyboard.type("sleep 30 && echo slept-$((1+1))\r");
  await expect(page.getByRole("button", { name: "Session actions for sleep" })).toBeVisible();
  const ctrl = key(page, "Control");
  await ctrl.click();
  await expect(ctrl).toHaveAttribute("aria-pressed", "true");
  // A Korean keyboard holds ㅊ as a preedit until the next jamo; the latched ctrl must not wait for that.
  await compose(page, "ㅊ");
  await expect(ctrl).toHaveAttribute("aria-pressed", "false");
  await expect(terminal.getByRole("textbox")).not.toHaveValue("ㅊ");
  await page.keyboard.type("echo after-$((40+4))\r");
  await expect(terminal).toContainText("after-44", { timeout: 10_000 });
  await expect(terminal).not.toContainText("slept-2");
});

test("tapping a modifier while a syllable composes sends the syllable plain, before the chord (#652)", async ({
  page,
}) => {
  const terminal = await openReader(page);
  await compose(page, "한");
  await key(page, "Option").click();
  await key(page, "Arrow keys").click();
  await page.getByRole("group", { name: "Arrow keys" }).getByRole("button", { name: "Left arrow" }).click();
  await key(page, "Return").click();
  // 한, then alt+left as xterm encodes it (ESC [ 1 ; 3 D); an alt that reached the syllable would put ESC before it.
  await expect(terminal).toContainText(`${HAN} 1b 5b 31 3b 33 44`, { timeout: 10_000 });
});

test("Paste while a syllable composes pastes after the syllable (#652)", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const terminal = await openReader(page);
  await page.evaluate(() => navigator.clipboard.writeText("zz"));
  await compose(page, "한");
  await key(page, "Paste").click();
  await pressReturn(page);
  await expect(terminal).toContainText(`${HAN} 7a 7a`, { timeout: 10_000 });
});

test("text the input method puts back before ending a taken composition is not sent with the next key (#652)", async ({
  page,
}) => {
  const terminal = await openReader(page);
  const field = terminal.getByRole("textbox");
  await compose(page, "한");
  await key(page, "Escape").click();
  // An input method that writes the syllable back into the emptied field, then ends the composition with it.
  await field.evaluate((el) => {
    if (!(el instanceof HTMLTextAreaElement)) throw new Error("the terminal's field is not a textarea");
    el.value = "한";
    el.dispatchEvent(new CompositionEvent("compositionend", { data: "한", bubbles: true }));
  });
  // A soft keyboard's next letter arrives as an input event, which reads the whole field.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.insertText", { text: "z" });
  await cdp.detach();
  await pressReturn(page);
  await expect(terminal).toContainText(`${HAN} 1b 7a`, { timeout: 10_000 });
  await expect(terminal).not.toContainText(`1b ${HAN}`);
});
