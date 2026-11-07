// Settings > This device (Host) with the paired host stopped, in both themes at 1440 and 390:
// CAPTURE=1 bunx playwright test devices-capture
import { type Browser, devices, type Page } from "@playwright/test";
import { join } from "node:path";
import { E2E_HOST_PORT, E2E_TOKEN } from "./config.ts";
import { expect, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";

const OUT = join(import.meta.dirname, "../../../docs/design/app");
const SHOTS = [
  { width: "1440", theme: "day" },
  { width: "1440", theme: "night" },
  { width: "390", theme: "day" },
  { width: "390", theme: "night" },
] as const;
type Shot = (typeof SHOTS)[number];

test.skip(process.env["CAPTURE"] !== "1", "captures run only with CAPTURE=1");
test.use({ page: async ({ page }, use) => use(page) });

const pairedDevices = (page: Page) =>
  page.locator("section").filter({ has: page.getByRole("heading", { name: "Host", exact: true }) });

/** Settings names the host while it answers, then the link drops: the row must still name it (#496). */
async function openPairedDevices(page: Page): Promise<void> {
  const socket = await routeHcSocket(page);
  const paired = pairedDevices(page);
  await page.goto("/settings");
  await expect(paired).toContainText("Connected", { timeout: 30_000 });
  await socket.drop(true);
  await expect(paired).toContainText(/Your host isn't (answering|connected right now)/, { timeout: 30_000 });
}

async function openPage(
  browser: Browser,
  shot: Shot,
): Promise<{ readonly page: Page; readonly close: () => Promise<void> }> {
  const size = shot.width === "1440" ? { viewport: { width: 1440, height: 900 } } : devices["iPhone 14"];
  const { defaultBrowserType: _browser, ...use } = { defaultBrowserType: "chromium", ...size };
  const context = await browser.newContext({ ...use, colorScheme: shot.theme === "day" ? "light" : "dark" });
  const connection = {
    mode: "loopback",
    relayUrl: "",
    directUrl: "",
    hostId: "",
    hostName: "",
    loopbackUrl: `ws://127.0.0.1:${E2E_HOST_PORT}/v1/hc`,
    token: E2E_TOKEN,
  };
  await context.addInitScript(
    ([chosen, stored]) => {
      localStorage.setItem("doriface.appearance", JSON.stringify({ theme: chosen, custom: [] }));
      localStorage.setItem("doriface.connection", stored);
    },
    [shot.theme, JSON.stringify(connection)] as const,
  );
  const page = await context.newPage();
  return { page, close: () => context.close() };
}

for (const shot of SHOTS) {
  test(`settings-paired-offline ${shot.width} ${shot.theme}`, async ({ browser }) => {
    const { page, close } = await openPage(browser, shot);
    try {
      await openPairedDevices(page);
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: join(OUT, `settings-paired-offline-${shot.width}-${shot.theme}.png`),
        animations: "disabled",
      });
    } finally {
      await close();
    }
  });
}
