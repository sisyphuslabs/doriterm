// Settings > Notifications off and on, in both themes at 1440 and 390: CAPTURE=1 bunx playwright test notifications-capture
import { type Browser, devices, type Page } from "@playwright/test";
import { join } from "node:path";
import { E2E_HOST_PORT, E2E_TOKEN } from "./config.ts";
import { expect, test } from "./fixtures.ts";
import { askHost, stubPushManager, TestPushService } from "./push.ts";
import { pushButton, openSettingsSection } from "./push-suite.ts";

const OUT = join(import.meta.dirname, "../../../docs/design/app");
const SHOTS = [
  { width: "1440", theme: "day" },
  { width: "1440", theme: "night" },
  { width: "390", theme: "day" },
  { width: "390", theme: "night" },
] as const;
type Shot = (typeof SHOTS)[number];

test.skip(process.env["CAPTURE"] !== "1", "captures run only with CAPTURE=1");
// The headless shell answers Notification.permission with "denied" whatever was granted; full Chromium honours it.
test.use({ channel: "chromium" });

let service: TestPushService;
test.beforeAll(async () => {
  service = await TestPushService.start();
});
test.afterAll(async () => {
  await askHost({ t: "unsubscribe", endpoint: service.endpoint });
  await service.close();
});

async function openSection(
  browser: Browser,
  { width, theme }: Shot,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const size = width === "1440" ? { viewport: { width: 1440, height: 900 } } : devices["iPhone 14"];
  const { defaultBrowserType: _browser, ...use } = { defaultBrowserType: "chromium", ...size };
  const context = await browser.newContext({ ...use, colorScheme: theme === "day" ? "light" : "dark" });
  await context.grantPermissions(["notifications"]);
  const connection = {
    mode: "loopback",
    relayUrl: "",
    directUrl: "",
    hostId: "",
    loopbackUrl: `ws://127.0.0.1:${E2E_HOST_PORT}/v1/hc`,
    token: E2E_TOKEN,
  };
  await context.addInitScript(
    ([chosen, stored]) => {
      localStorage.setItem("doriface.appearance", JSON.stringify({ theme: chosen, custom: [] }));
      localStorage.setItem("doriface.connection", stored);
    },
    [theme, JSON.stringify(connection)] as const,
  );
  const page = await context.newPage();
  await stubPushManager(page, service);
  await page.goto("/settings");
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.goto("/settings");
  await openSettingsSection(page, "Notifications");
  await expect(page.getByRole("heading", { name: "Notifications", exact: true })).toBeVisible();
  return { page, close: () => context.close() };
}

async function shoot(page: Page, shot: Shot, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(OUT, `${name}-${shot.width}-${shot.theme}.png`) });
}

/** One shot after another: they share the host's one subscription. */
async function eachShot(take: (shot: Shot) => Promise<void>, index = 0): Promise<void> {
  const shot = SHOTS[index];
  if (shot === undefined) return;
  await take(shot);
  return eachShot(take, index + 1);
}

test("notifications, off and on", async ({ browser }) => {
  await eachShot(async (shot) => {
    const { page, close } = await openSection(browser, shot);
    const state = page.locator("[data-push-state]");
    await expect(state).toHaveAttribute("data-push-state", "off");
    await shoot(page, shot, "notifications-off");
    await pushButton(page, "Turn on").click();
    await expect(state).toHaveAttribute("data-push-state", "on");
    await expect(state.getByRole("switch", { name: /^Notifications from / }).first()).toBeVisible();
    await shoot(page, shot, "notifications-on");
    await pushButton(page, "Turn off").click();
    await expect(state).toHaveAttribute("data-push-state", "off");
    await close();
  });
});
