import type { Locator, Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { asMac, copyImage, makePng, readRawBytes } from "./clipboard-image.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { MACHINE_NAME } from "./machine.ts";
import { newOn, reconnect } from "./machine-switch.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { pagePlatform, pressWithCommand, triggersFor } from "./platform-keys.ts";
import { machineConnected } from "./sidebar-seed.ts";

// #701: an image pasted or dropped into a terminal goes to the terminal's machine as a file (`terminal.put`), and its
// path is pasted there, as herdr-app's terminal.paste_image does, so an agent on that machine reads it by its path.
endOwnTerminals();
test.use({ serviceWorkers: "block", permissions: ["clipboard-read", "clipboard-write"] });

const sha256 = (base64: string): string => createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");

/** The platform's paste chord as the browser delivers it: a keydown carrying its own `paste` command (#510, #862). */
async function pressPaste(page: Page): Promise<void> {
  const [chord = ""] = triggersFor(await pagePlatform(page), "terminal.paste");
  await pressWithCommand(page, chord, "paste");
}

/** Fires a paste or a drop on the terminal carrying one PNG-typed file `name` with the base64 bytes `png`. */
const fireFile = (terminal: Locator, type: "paste" | "drop", name: string, png: string): Promise<void> =>
  terminal.evaluate(
    (element, [kind, fileName, data]) => {
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], fileName, { type: "image/png" }));
      const target = element.querySelector("textarea") ?? element;
      if (kind === "paste") {
        target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
        return;
      }
      for (const step of ["dragenter", "dragover", "drop"]) {
        target.dispatchEvent(new DragEvent(step, { dataTransfer: transfer, bubbles: true, cancelable: true }));
      }
    },
    [type, name, png] as const,
  );

async function remoteTerminal(page: Page): Promise<Locator> {
  reconnect();
  await machineConnected(MACHINE_NAME);
  await page.goto("/");
  await newOn(page).click({ force: true });
  const terminal = page.locator(`[data-terminal^="${MACHINE_NAME}/"]`).first();
  await expect(terminal).toContainText("$", { timeout: 30_000 });
  await terminal.getByRole("textbox").focus();
  return terminal;
}

test("an image alone on the clipboard lands on the added machine as a file, and its path is pasted", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const terminal = await remoteTerminal(page);
  await copyImage(page, await makePng(page, 77, 10));
  // The shell on build-box reads the file at the pasted path. The clipboard re-encodes the PNG, so its bytes differ from
  // the ones written; its header's width and height (IHDR, bytes 16-23) are the image's, so the image landed there.
  await page.keyboard.type("od -An -tu1 -j16 -N8 ");
  await pressPaste(page);
  await expect(terminal).toContainText("doriface-paste-", { timeout: 30_000 });
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText(/0\s+0\s+0\s+77\s+0\s+0\s+0\s+77/, { timeout: 30_000 });
});

test("the path goes in as a bracketed paste when the program asked for one", async ({ page }) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type(
    "printf '\\033[?2004h'; IFS= read -r line; printf 'GOT:%s\\n' \"$(printf '%s' \"$line\" | tr '\\033' '@')\"\r",
  );
  await expect(terminal).toContainText("read -r line", { timeout: 15_000 });
  await copyImage(page, await makePng(page, 8, 120));
  await pressPaste(page);
  // The put is async: Enter waits for the pasted path, echoed by the line `read` is filling, or `read` gets an empty line.
  await expect(terminal).toContainText("doriface-paste-", { timeout: 30_000 });
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText(/GOT:@\[200~\S*doriface-paste-\d+\.png @\[201~/, { timeout: 30_000 });
});

test("text on the clipboard still pastes as text", async ({ page }) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  await page.evaluate(() => navigator.clipboard.writeText("pasted-$((6*7))"));
  await page.keyboard.type("echo ");
  await pressPaste(page);
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("pasted-42", { timeout: 15_000 });
});

test("a PNG dropped on a terminal on the added machine lands there under its own name", async ({ page }) => {
  test.setTimeout(120_000);
  const terminal = await remoteTerminal(page);
  const png = await makePng(page, 32, 240);
  await page.keyboard.type("sha256sum ");
  await fireFile(terminal, "drop", "diagram one.png", png);
  // The core keeps the name, as a shell word: its space becomes an underscore.
  await expect(terminal).toContainText("diagram_one.png", { timeout: 30_000 });
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText(sha256(png), { timeout: 30_000 });
});

test("an image past 8 MB is refused with a notice and nothing reaches the terminal", async ({ page }) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  // Base64 of 9 MiB of bytes; the type is all that makes it an image here.
  const big = Buffer.alloc(9 << 20, 1).toString("base64");
  await page.keyboard.type("echo before-");
  await fireFile(terminal, "paste", "huge.png", big);
  await expect(page.getByText("huge.png is 9.0 MB; at most 8 MB can be sent")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.type("after\r");
  await expect(terminal).toContainText("before-after", { timeout: 15_000 });
});

// herdr-app binds Ctrl+V to terminal.paste_image (#1922). On a Mac Ctrl+V is not the paste key, so the app reads the
// clipboard for an image, and without one, or where the page may not read it (the desktop app), the program gets ^V,
// with keys typed meanwhile behind it. On Linux and Windows Ctrl+V stays the browser's paste, as before: an image goes
// in as a file through the paste itself (#742) and text as text, with no clipboard permission needed.

async function asLinux(page: Page): Promise<void> {
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "Linux x86_64" }));
}

/** The page may not read the clipboard, as in the desktop app or after a person says no. */
async function readDenied(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Clipboard.prototype.read = () => Promise.reject(new DOMException("Read permission denied.", "NotAllowedError"));
  });
}

test("Ctrl+V pastes the clipboard's image by its path on a Mac, as herdr-app does", async ({ page }) => {
  await asMac(page);
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  await copyImage(page, await makePng(page, 9, 60));
  await page.keyboard.type("echo ");
  await page.keyboard.press("Control+KeyV");
  await expect(terminal).toContainText("doriface-paste-", { timeout: 30_000 });
});

test("Ctrl+V with no image on the clipboard sends ^V to the program on a Mac", async ({ page }) => {
  await asMac(page);
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  await page.evaluate(() => navigator.clipboard.writeText("only-text"));
  await readRawBytes(page, terminal, 1);
  await page.keyboard.press("Control+KeyV");
  await expect(terminal).toContainText("HEX:16", { timeout: 15_000 });
  await expect(terminal).not.toContainText("only-text");
});

test("Ctrl+V sends ^V on a Mac when the page may not read the clipboard, an image on it or not", async ({ page }) => {
  await asMac(page);
  await readDenied(page);
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  await copyImage(page, await makePng(page, 9, 70));
  await readRawBytes(page, terminal, 1);
  await page.keyboard.press("Control+KeyV");
  await expect(terminal).toContainText("HEX:16", { timeout: 15_000 });
});

test("a key typed while Ctrl+V reads the clipboard reaches the program after its ^V, on a Mac", async ({ page }) => {
  await asMac(page);
  // The clipboard answers only when the test says, as when a browser asks the person first.
  await page.addInitScript(() => {
    const read = Clipboard.prototype.read;
    Clipboard.prototype.read = function held(this: Clipboard) {
      return new Promise<ClipboardItems>((resolve) => {
        Object.assign(window, { answerClipboard: () => resolve(read.call(this)) });
      });
    };
  });
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  await page.evaluate(() => navigator.clipboard.writeText("only-text"));
  await readRawBytes(page, terminal, 2);
  await page.keyboard.press("Control+KeyV");
  await page.keyboard.press("x");
  await page.waitForFunction(() => "answerClipboard" in window);
  await page.evaluate(() => Reflect.get(window, "answerClipboard")());
  await expect(terminal).toContainText(/HEX:\S+ \S+/u, { timeout: 15_000 });
  await expect(terminal).toContainText("HEX:16 78");
});

test("a clipboard that never answers holds keys typed after Ctrl+V only briefly, and sends no ^V while it may still answer, on a Mac (#1989)", async ({
  page,
}) => {
  await asMac(page);
  // The read never settles, as when a browser's prompt is left unanswered; only Paste image's own bound lets keys out.
  await page.addInitScript(() => {
    Clipboard.prototype.read = () => new Promise<ClipboardItems>(() => undefined);
  });
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  await readRawBytes(page, terminal, 2);
  await page.keyboard.press("Control+KeyV");
  await page.keyboard.type("xy");
  await expect(terminal).toContainText(/HEX:\S+ \S+/u, { timeout: 15_000 });
  await expect(terminal).toContainText("HEX:78 79");
  await expect(page.getByText("Waiting for the clipboard")).toBeVisible();
});

test("an image the clipboard gives after Ctrl+V's wait is pasted by its path then, after the keys typed meanwhile, with no ^V, on a Mac (#1938)", async ({
  page,
}) => {
  await asMac(page);
  // The clipboard answers only when the test says, as when Safari's Paste button waits for the person's click.
  await page.addInitScript(() => {
    const read = Clipboard.prototype.read;
    Clipboard.prototype.read = function held(this: Clipboard) {
      return new Promise<ClipboardItems>((resolve) => {
        Object.assign(window, { answerClipboard: () => resolve(read.call(this)) });
      });
    };
  });
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  await copyImage(page, await makePng(page, 9, 90));
  // With lnext off the tty hands a ^V to `read` as it is, and `tr` shows it as @.
  await page.keyboard.type(
    "stty -iexten; IFS= read -r line; printf 'GOT:%s\\n' \"$(printf '%s' \"$line\" | tr '\\026' '@')\"\r",
  );
  await expect(terminal).toContainText("read -r line", { timeout: 15_000 });
  await page.keyboard.press("Control+KeyV");
  await page.keyboard.type("zebra");
  // Past the wait the keys reach the program while the clipboard is still asking, and a notice says it is waiting.
  await expect(terminal).toContainText("zebra", { timeout: 15_000 });
  const notice = page.getByText("Waiting for the clipboard");
  await expect(notice).toBeVisible();
  await page.evaluate(() => Reflect.get(window, "answerClipboard")());
  await expect(terminal).toContainText("doriface-paste-", { timeout: 30_000 });
  await expect(notice).toBeHidden();
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText(/GOT:zebra[^@]*doriface-paste-\d+\.png/u, { timeout: 30_000 });
});

test("Ctrl+V pastes the clipboard's image by its path on Linux, though the page may not read the clipboard", async ({
  page,
}) => {
  await asLinux(page);
  await readDenied(page);
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  await copyImage(page, await makePng(page, 9, 80));
  await page.keyboard.type("echo ");
  await page.keyboard.press("Control+KeyV");
  await expect(terminal).toContainText("doriface-paste-", { timeout: 30_000 });
});

test("Ctrl+V pastes the clipboard's text on Linux, as before", async ({ page }) => {
  await asLinux(page);
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  await page.evaluate(() => navigator.clipboard.writeText("only-text"));
  await readRawBytes(page, terminal, 1);
  await page.keyboard.press("Control+KeyV");
  await expect(terminal).toContainText("HEX:6f", { timeout: 15_000 });
});

test("several lines of text still ask before they run, as clipboard-paste-protection does", async ({ page }) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  await page.evaluate(() => navigator.clipboard.writeText("echo one-$((1+1))\necho two-$((2+2))"));
  await pressPaste(page);
  const dialog = page.getByRole("dialog", { name: "Paste 2 lines?" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole("button", { name: "Paste" }).click();
  await expect(terminal).toContainText("one-2", { timeout: 15_000 });
});
