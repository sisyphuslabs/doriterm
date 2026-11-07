import type { CDPSession, Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { type ImeStep, JAPANESE_IME_CHORDS, KOREAN_IME_CHORDS } from "./korean-ime-chords.ts";

test.use({ serviceWorkers: "block" });

const CTRL = 2;

async function replay(cdp: CDPSession, step: ImeStep): Promise<void> {
  switch (step.kind) {
    case "keydown":
    case "keyup":
      await cdp.send("Input.dispatchKeyEvent", {
        type: step.kind === "keydown" ? "rawKeyDown" : "keyUp",
        key: step.key,
        code: step.code,
        windowsVirtualKeyCode: step.keyCode,
        modifiers: step.ctrl ? CTRL : 0,
      });
      return;
    case "compose":
      await cdp.send("Input.imeSetComposition", {
        text: step.text,
        selectionStart: step.text.length,
        selectionEnd: step.text.length,
      });
      return;
    case "commit":
      await cdp.send("Input.insertText", { text: step.text });
      return;
  }
}

/** Puts the shell in raw mode and reads `count` bytes, printed in hex: ^C arrives as a byte, not as an interrupt. */
async function readRawBytes(page: Page, count: number): Promise<void> {
  await page.keyboard.type(`stty raw -echo; echo raw-$((2+3)); head -c ${count} | od -An -tx1; stty sane\r`);
}

const AFTER = "xyz";
const AFTER_BYTES = "78 79 7a";

for (const chord of [...KOREAN_IME_CHORDS, ...JAPANESE_IME_CHORDS]) {
  test(`${chord.name}: the program reads what was typed once, and the chord only when it is the program's (#748)`, async ({
    page,
  }) => {
    await page.goto("/");
    const terminal = await openNewTerminal(page);
    const expected = `${chord.bytes} ${AFTER_BYTES}`;
    await readRawBytes(page, expected.split(" ").length);
    await expect(terminal).toContainText("raw-5", { timeout: 10_000 });

    const cdp = await page.context().newCDPSession(page);
    for (const step of chord.steps) {
      // oxlint-disable-next-line no-await-in-loop -- the events are an ordered recording: each lands before the next
      await replay(cdp, step);
    }
    await cdp.detach();
    // Plain keys after the chord close the read: a dropped chord leaves it short, a repeated syllable shifts them.
    await page.keyboard.type(AFTER);
    await expect(terminal).toContainText(expected, { timeout: 10_000 });
  });
}
