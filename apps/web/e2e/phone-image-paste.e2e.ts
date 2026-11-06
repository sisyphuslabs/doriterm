import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures.ts";
import { key, openPhoneTerminal, PHONE } from "./phone-key-bar.ts";

// #701 on the phone: the key bar's Paste with an image alone on the clipboard puts it on the terminal's machine and
// pastes its path, as the paste chord does on a desktop. IMAGE_PASTE_OUT keeps the capture.
test.use({ serviceWorkers: "block", ...PHONE, permissions: ["clipboard-read", "clipboard-write"] });

test("the Paste key puts a copied image on the terminal's machine and pastes its path", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(91, 91);
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("no canvas");
    context.fillRect(0, 0, 91, 91);
    const png = await canvas.convertToBlob({ type: "image/png" });
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  });
  await page.keyboard.type("od -An -tu1 -j16 -N8 ");
  await key(page, "Paste").click();
  await expect(terminal).toContainText("doriface-paste-", { timeout: 30_000 });
  await page.keyboard.type("\r");
  // The PNG header's width and height, read on the terminal's machine at the pasted path.
  await expect(terminal).toContainText(/0\s+0\s+0\s+91\s+0\s+0\s+0\s+91/, { timeout: 30_000 });

  const path = test.info().outputPath("phone-image-paste.png");
  await page.screenshot({ path });
  const out = process.env["IMAGE_PASTE_OUT"];
  if (out !== undefined) {
    mkdirSync(out, { recursive: true });
    copyFileSync(path, join(out, "phone-image-paste.png"));
  }
});
