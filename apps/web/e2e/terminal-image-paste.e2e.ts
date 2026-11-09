import type { Locator, Page } from "@playwright/test";
import { createHash } from "node:crypto";
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

/** A PNG made in the page, as base64: `size` px square, a colour of its own so each test's bytes differ. */
const makePng = (page: Page, size: number, hue: number): Promise<string> =>
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

const sha256 = (base64: string): string => createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");

/** Puts the PNG on the system clipboard, alone, as a screenshot leaves it. */
const copyImage = (page: Page, png: string): Promise<void> =>
  page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([bytes], { type: "image/png" }) })]);
  }, png);

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

// herdr-app binds Ctrl+V to terminal.paste_image on every platform (#1922): an image on the clipboard is pasted as a file
// on the terminal's machine, and without one the program gets ^V, as from the key itself.
for (const platform of ["MacIntel", "Linux x86_64"]) {
  test(`Ctrl+V pastes the clipboard's image by its path, as herdr-app does (${platform})`, async ({ page }) => {
    await page.addInitScript((value) => {
      Object.defineProperty(Navigator.prototype, "platform", { get: () => value });
    }, platform);
    await page.goto("/");
    const terminal = await openNewTerminal(page);
    await terminal.getByRole("textbox").focus();
    await copyImage(page, await makePng(page, 9, 60));
    await page.keyboard.type("echo ");
    await page.keyboard.press("Control+KeyV");
    await expect(terminal).toContainText("doriface-paste-", { timeout: 30_000 });
  });

  test(`Ctrl+V with no image on the clipboard sends ^V to the program (${platform})`, async ({ page }) => {
    await page.addInitScript((value) => {
      Object.defineProperty(Navigator.prototype, "platform", { get: () => value });
    }, platform);
    await page.goto("/");
    const terminal = await openNewTerminal(page);
    await terminal.getByRole("textbox").focus();
    await page.evaluate(() => navigator.clipboard.writeText("only-text"));
    // Raw mode, so the tty hands ^V to dd rather than reading it as its literal-next key; RAW-ON is printed once it is.
    await page.keyboard.type(
      "stty raw -echo; printf 'RAW%s\\r\\n' -ON; dd bs=1 count=1 2>/dev/null | od -An -tx1 | sed 's/^ */HEX:/'; stty sane\r",
    );
    await expect(terminal).toContainText("RAW-ON", { timeout: 15_000 });
    await page.keyboard.press("Control+KeyV");
    await expect(terminal).toContainText("HEX:16", { timeout: 15_000 });
    await expect(terminal).not.toContainText("only-text");
  });
}

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
