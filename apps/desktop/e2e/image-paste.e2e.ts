import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchHcSession } from "./hc-session.ts";
import { launchOptions, pressNewTab } from "./launch.ts";

// #701 in the app: an image alone on the system clipboard, pasted with the app's own paste command, goes to the
// terminal's machine as a file and its path is pasted, as in a browser. IMAGE_PASTE_OUT keeps the capture.

interface Scratch {
  readonly hc: ReturnType<typeof scratchHcSession>;
  readonly profile: string;
  readonly shellHome: string;
}
let scratch: Scratch | undefined;
let launched: ElectronApplication | undefined;

test.beforeAll(async () => {
  const hc = scratchHcSession();
  const profile = mkdtempSync(join(tmpdir(), "dd-image-paste-"));
  const shellHome = mkdtempSync(join(tmpdir(), "dd-image-paste-shell-"));
  writeFileSync(join(shellHome, "clean-shell"), "#!/bin/sh\nexec /bin/sh -i\n", { mode: 0o755 });
  scratch = { hc, profile, shellHome };
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      ...hc.env,
      SHELL: "clean-shell",
      PATH: `${shellHome}:${process.env["PATH"] ?? ""}`,
      HOME: shellHome,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  launched = await electron.launch(await launchOptions([`--user-data-dir=${profile}`], { env }));
});

test.afterAll(async () => {
  try {
    await launched?.close();
  } finally {
    if (scratch !== undefined) {
      await scratch.hc.dispose();
      rmSync(scratch.profile, { recursive: true, force: true });
      rmSync(scratch.shellHome, { recursive: true, force: true });
    }
  }
});

test("an image alone on the clipboard, pasted in the app, lands beside the terminal and its path is pasted (#701)", async () => {
  if (launched === undefined) throw new Error("the app did not launch");
  const page = await launched.firstWindow();
  await page.waitForSelector("#root > *");
  await page.getByRole("button", { name: "Use this computer" }).click();
  await pressNewTab(page, { timeout: 30_000 });
  const terminal = page.locator('[data-focused="true"] [data-terminal]');
  await expect(terminal).toContainText("$", { timeout: 30_000 });
  await terminal.getByRole("textbox").focus();

  const png = await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(83, 83);
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("no canvas");
    context.fillRect(0, 0, 83, 83);
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  });
  await launched.evaluate(async ({ clipboard, ClipboardItem }, data) => {
    const image = new Blob([Buffer.from(data, "base64")], { type: "image/png" });
    await clipboard.write([new ClipboardItem({ "image/png": image })]);
  }, png);

  await page.keyboard.type("od -An -tu1 -j16 -N8 ");
  // The app's Edit > Paste: the window's own paste command, which reads the system clipboard.
  await launched.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.paste());
  await expect(terminal).toContainText("doriface-paste-", { timeout: 30_000 });
  await page.keyboard.press("Enter");
  // The PNG header's width and height, read by the shell at the pasted path.
  await expect(terminal).toContainText(/0\s+0\s+0\s+83\s+0\s+0\s+0\s+83/, { timeout: 30_000 });

  const path = test.info().outputPath("desktop-image-paste.png");
  await page.screenshot({ path });
  const out = process.env["IMAGE_PASTE_OUT"];
  if (out !== undefined) {
    mkdirSync(out, { recursive: true });
    copyFileSync(path, join(out, "desktop-image-paste.png"));
  }
});
