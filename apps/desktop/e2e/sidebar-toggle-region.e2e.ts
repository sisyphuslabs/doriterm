import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAC_INSET_CSS, MAC_TITLEBAR_CSS } from "../src/config/window.ts";
import { appRegionAt } from "./app-region.ts";
import { scratchHcSession } from "./hc-session.ts";
import { launchOptions } from "./launch.ts";

// The sidebar toggle must take a person's click, not only Playwright's: on macOS a press inside a drag region moves the
// window before the page sees it, so a toggle that a later drag row covers never brings a hidden sidebar back (#643).
// The drag rows are the macOS titlebar's; on another platform the spec adds the same sheets the macOS window gets.

interface Scratch {
  readonly hc: ReturnType<typeof scratchHcSession>;
  readonly profile: string;
  readonly shellHome: string;
}
let scratch: Scratch | undefined;
let launched: ElectronApplication | undefined;

test.beforeAll(async () => {
  const hc = scratchHcSession();
  const profile = mkdtempSync(join(tmpdir(), "dd-toggle-region-"));
  const shellHome = mkdtempSync(join(tmpdir(), "dd-toggle-region-shell-"));
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

const running = (): ElectronApplication => {
  if (launched === undefined) throw new Error("the app did not launch");
  return launched;
};

async function regionOfButton(page: Page, name: string): Promise<string> {
  const box = await page.getByRole("button", { name, exact: true }).boundingBox();
  if (box === null) throw new Error(`no ${name} button on screen`);
  return page.evaluate(appRegionAt, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
}

test("the sidebar toggle takes a real click with the sidebar open, hidden and a rail (#643)", async () => {
  const app = running();
  const page = await app.firstWindow();
  await page.waitForSelector("#root > *");
  if (process.platform !== "darwin") {
    await app.evaluate(
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
  const strip = await page.getByRole("tablist", { name: "Tabs" }).boundingBox();
  if (strip === null) throw new Error("no tab strip");

  expect(await regionOfButton(page, "Hide sidebar"), "sidebar open").toBe("no-drag");

  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await expect(sidebar).toBeHidden();
  // The strip's own empty stretch still moves the window, so the reading above is not a page with no drag rows at all.
  const empty = { x: strip.x + strip.width - 4, y: strip.y + strip.height / 2 };
  expect(await page.evaluate(appRegionAt, empty), "the tab strip's empty stretch").toBe("drag");
  expect(await regionOfButton(page, "Show sidebar"), "sidebar hidden").toBe("no-drag");

  await page.getByRole("button", { name: "Show sidebar" }).click();
  await expect(sidebar).toBeVisible();
  await page.getByRole("separator", { name: "Resize sidebar" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("separator", { name: "Resize sidebar" })).toHaveAttribute("aria-valuetext", "Icon rail");
  expect(await regionOfButton(page, "Hide sidebar"), "sidebar a rail").toBe("no-drag");
});
