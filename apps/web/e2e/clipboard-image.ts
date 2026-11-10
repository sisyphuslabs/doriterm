import type { Locator, Page } from "@playwright/test";
import { expect } from "./fixtures.ts";

// The clipboard and the shell as the Paste image specs (#1922, #1938) set them up.

/** A PNG made in the page, as base64: `size` px square, a colour of its own so each test's bytes differ. */
export const makePng = (page: Page, size: number, hue: number): Promise<string> =>
  page.evaluate(
    async ([side, colour]) => {
      const canvas = new OffscreenCanvas(side, side);
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("no canvas");
      context.fillStyle = `hsl(${colour} 80% 50%)`;
      context.fillRect(0, 0, side, side);
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    },
    [size, hue] as const,
  );

/** Puts the PNG on the system clipboard, alone, as a screenshot leaves it. */
export const copyImage = (page: Page, png: string): Promise<void> =>
  page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([bytes], { type: "image/png" }) })]);
  }, png);

/** A Mac page in this Linux Chromium: the platform says MacIntel, and the paste Ctrl+V fires here, never on a Mac, is dropped. */
export async function asMac(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" });
    window.addEventListener(
      "paste",
      (event) => {
        if (!event.isTrusted) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      true,
    );
  });
}

/** A shell reading `count` raw bytes, so the tty hands ^V to dd rather than reading it as literal-next; prints HEX:... */
export async function readRawBytes(page: Page, terminal: Locator, count: number): Promise<void> {
  await page.keyboard.type(
    `stty raw -echo; printf 'RAW%s\\r\\n' -ON; dd bs=1 count=${count} 2>/dev/null | od -An -tx1 | sed 's/^ */HEX:/'; stty sane\r`,
  );
  await expect(terminal).toContainText("RAW-ON", { timeout: 15_000 });
}

/**
 * The clipboard answers only when the test says (`answerClipboard`), as when a browser asks the person to allow the
 * paste first; every read made until then answers then.
 */
export async function holdClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const read = Clipboard.prototype.read;
    const held: (() => void)[] = [];
    Clipboard.prototype.read = function heldRead(this: Clipboard) {
      return new Promise<ClipboardItems>((resolve) => held.push(() => resolve(read.call(this))));
    };
    Object.assign(window, { answerClipboard: () => held.splice(0).forEach((answer) => answer()) });
  });
}

export const answerClipboard = (page: Page): Promise<void> =>
  page.evaluate(() => Reflect.get(window, "answerClipboard")());
