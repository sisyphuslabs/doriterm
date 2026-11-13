// Settings > Notifications in the desktop app, off and on, in both themes at 1440 and 390:
// CAPTURE=1 CAPTURE_DIR=<dir> bunx playwright test notifications-capture
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchHcSession } from "./hc-session.ts";
import { launchOptions } from "./launch.ts";

test.skip(process.env["CAPTURE"] !== "1", "captures run only with CAPTURE=1");

let session: ReturnType<typeof scratchHcSession> | undefined;
let profile: string | undefined;
let launched: ElectronApplication | undefined;

test.beforeAll(async () => {
  session = scratchHcSession();
  profile = mkdtempSync(join(tmpdir(), "dd-profile-"));
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...session.env }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  launched = await electron.launch(await launchOptions([`--user-data-dir=${profile}`], { env }));
  await launched.evaluate(({ Notification }) => {
    Notification.isSupported = () => true;
  });
});

test.afterAll(async () => {
  try {
    await launched?.close();
  } finally {
    await session?.dispose();
    if (profile !== undefined) rmSync(profile, { recursive: true, force: true });
  }
});

const SHOTS = [
  { width: 1440, height: 900, theme: "day" },
  { width: 390, height: 844, theme: "day" },
  { width: 1440, height: 900, theme: "night" },
  { width: 390, height: 844, theme: "night" },
] as const;
type Shot = (typeof SHOTS)[number];

const section = (page: Page) => page.locator("[data-push-state]");

async function shoot(page: Page, name: string): Promise<void> {
  // Off the button just pressed, so the shot shows its resting state rather than its hover.
  await page.mouse.move(1, 1);
  await page.evaluate(() => document.fonts.ready);
  // Turn on becomes Turn off in place, its fill transitioning from the primary colour: the shot waits for it to settle.
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
  const dir = process.env["CAPTURE_DIR"] ?? test.info().outputDir;
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

/** Settings > Notifications at the shot's width and theme, off and then on; Turn off leaves it off for the next. */
async function take(page: Page, { width, height, theme }: Shot): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.evaluate((chosen) => {
    localStorage.setItem("doriface.appearance", JSON.stringify({ theme: chosen, custom: [] }));
    history.replaceState(null, "", "/settings");
    location.reload();
  }, theme);
  await page
    .getByRole("navigation", { name: "Settings", exact: true })
    .getByRole("button", { name: "Notifications", exact: true })
    .or(page.getByRole("tablist").getByRole("tab", { name: "Notifications", exact: true }))
    .filter({ visible: true })
    .click();
  await expect(section(page)).toHaveAttribute("data-push-state", "off");
  await shoot(page, `desktop-notifications-off-${width}-${theme}`);
  await section(page).getByRole("button", { name: "Turn on", exact: true }).click();
  await expect(section(page)).toHaveAttribute("data-push-state", "on");
  await shoot(page, `desktop-notifications-on-${width}-${theme}`);
  await section(page).getByRole("button", { name: "Turn off", exact: true }).click();
  await expect(section(page)).toHaveAttribute("data-push-state", "off");
}

/** One shot after another: they share the one window. */
async function eachShot(page: Page, index = 0): Promise<void> {
  const shot = SHOTS[index];
  if (shot === undefined) return;
  await take(page, shot);
  return eachShot(page, index + 1);
}

test("desktop notifications, off and on", async () => {
  if (launched === undefined) throw new Error("the app did not launch");
  const page = await launched.firstWindow();
  await page.getByRole("button", { name: "Use this computer" }).click();
  await expect(
    page
      .getByRole("button", { name: "New tab" })
      .or(page.getByRole("button", { name: "New terminal" }))
      .first(),
  ).toBeVisible({ timeout: 30_000 });
  await eachShot(page);
});
