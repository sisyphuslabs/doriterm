import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAC_INSET_CSS, MAC_TITLEBAR_CSS } from "../src/config/window.ts";
import { appRegionAt } from "./app-region.ts";
import { scratchHcSession } from "./hc-session.ts";
import { launchOptions, pressNewTab } from "./launch.ts";

// In the app a right-click on a sidebar row opens the row's own menu, as in a browser (#699): the row lies outside every
// drag region, which on macOS would take the press before the page sees it. Other platforms get the macOS sheets added.

interface Scratch {
  readonly hc: ReturnType<typeof scratchHcSession>;
  readonly profile: string;
  readonly shellHome: string;
}
let scratch: Scratch | undefined;
let launched: ElectronApplication | undefined;

test.beforeAll(async () => {
  const hc = scratchHcSession();
  const profile = mkdtempSync(join(tmpdir(), "dd-row-menu-"));
  const shellHome = mkdtempSync(join(tmpdir(), "dd-row-menu-shell-"));
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

test("right-clicking an agent row in the app opens its menu, and Rename… asks for the new name (#699)", async () => {
  if (launched === undefined) throw new Error("the app did not launch");
  const page = await launched.firstWindow();
  await page.waitForSelector("#root > *");
  if (process.platform !== "darwin") {
    await launched.evaluate(
      async ({ BrowserWindow }, sheets) => {
        const contents = BrowserWindow.getAllWindows()[0]?.webContents;
        if (contents === undefined) throw new Error("no window");
        await Promise.all(sheets.map((sheet) => contents.insertCSS(sheet)));
      },
      [MAC_TITLEBAR_CSS, MAC_INSET_CSS],
    );
  }
  await page.getByRole("button", { name: "Use this computer" }).click();
  const sidebar = page.getByRole("complementary", { name: "Workspace" });
  await expect(sidebar).toBeVisible({ timeout: 30_000 });
  await pressNewTab(page, { timeout: 30_000 });
  const row = sidebar.getByRole("region", { name: "Agents", exact: true }).locator("button:not([aria-label])").first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  const box = await row.boundingBox();
  if (box === null) throw new Error("no agent row on screen");
  const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  expect(await page.evaluate(appRegionAt, middle), "the row takes its own presses").not.toBe("drag");

  await row.click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem")).toHaveText(["Pin to top", "Rename…", "End session…"]);
  await menu.getByRole("menuitem", { name: "Rename…" }).click();
  const dialog = page.getByRole("dialog", { name: /^Rename / });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
