// This computer's pairing offer in the desktop app, light and dark at 1440 and 390:
// CAPTURE=1 CAPTURE_DIR=<dir> bunx playwright test pair-device-capture
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchHcSession } from "./hc-session.ts";
import { launchOptions } from "./launch.ts";
import { pairRig, type PairRig } from "./pair-harness.ts";

test.skip(process.env["CAPTURE"] !== "1", "captures run only with CAPTURE=1");
test.setTimeout(300_000);

let rig: PairRig;
let hc: ReturnType<typeof scratchHcSession>;
let profile: string;
let app: ElectronApplication | undefined;
let page: Page;

const SHOTS = [
  { width: 1440, height: 900, mode: "light" },
  { width: 390, height: 844, mode: "light" },
  { width: 1440, height: 900, mode: "dark" },
  { width: 390, height: 844, mode: "dark" },
] as const;
type Shot = (typeof SHOTS)[number];

const originOf = (target: Page): string => {
  const url = new URL(target.url());
  return `${url.protocol}//${url.host}`;
};

// oxlint-disable-next-line no-empty-pattern -- Playwright reads a hook's fixtures from this pattern; this one takes the hook's own timeout.
test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(240_000);
  rig = await pairRig();
  hc = scratchHcSession();
  profile = mkdtempSync(join(tmpdir(), "dd-pair-capture-"));
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...hc.env, ...rig.env }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  app = await electron.launch(await launchOptions([`--user-data-dir=${profile}`], { env }));
  page = await app.firstWindow();
  const started = page.getByRole("button", { name: "Use this computer" });
  const workspace = page
    .getByRole("button", { name: "New tab" })
    .or(page.getByRole("button", { name: "New terminal" }))
    .first();
  await expect(started.or(workspace)).toBeVisible({ timeout: 120_000 });
  if (await started.isVisible()) await started.click();
  await expect(workspace).toBeVisible({ timeout: 120_000 });
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await hc?.dispose().catch(() => undefined);
  await rig?.stop().catch(() => undefined);
  if (profile !== undefined) rmSync(profile, { recursive: true, force: true });
});

async function shoot(name: string): Promise<void> {
  await page.mouse.move(1, 1);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
  const dir = process.env["CAPTURE_DIR"] ?? test.info().outputDir;
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

async function take({ width, height, mode }: Shot): Promise<void> {
  const origin = originOf(page);
  await page.setViewportSize({ width, height });
  await page.evaluate((chosen) => {
    localStorage.setItem(
      "doriface.appearance",
      JSON.stringify({ mode: chosen, dark: "night", light: "day", density: "comfortable", custom: [] }),
    );
  }, mode);
  await page.goto(`${origin}/settings`);
  await page.getByRole("heading", { name: "Settings" }).first().waitFor();
  await page
    .getByRole("navigation", { name: "Settings", exact: true })
    .getByRole("button", { name: "This device", exact: true })
    .or(page.getByRole("tab", { name: "This device", exact: true }))
    .filter({ visible: true })
    .click();
  await page.getByRole("button", { name: "Pair a device", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Pair a device" });
  await expect(dialog.locator("[data-pair-code]")).toBeVisible({ timeout: 60_000 });
  await shoot(`desktop-pair-device-${width}-${mode}`);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}

test("this computer's pairing offer, light and dark at 1440 and 390", async () => {
  for (const shot of SHOTS) {
    // oxlint-disable-next-line no-await-in-loop -- one window: each shot is taken before the next theme loads
    await take(shot);
  }
});
