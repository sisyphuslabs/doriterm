// A release build reaches only the production relay (#389): Settings > This device offers no relay address to edit and
// no Loopback dev switch, and a custom relay address saved by an older build is never dialled.
import { devices, type Page } from "@playwright/test";
import { join } from "node:path";
import { expect, test } from "./fixtures.ts";

// Any port: a session's second and third sockets dial the relay's other HTTPS ports (#1418).
const PRODUCTION = /^wss:\/\/relay-doriface\.omo\.dev(:\d+)?\//;
const CUSTOM = /^wss:\/\/relay\.custom\.invalid(:\d+)?\//;

/** A paired host saved with a custom relay address, over the fixture's loopback link. */
async function saveCustomRelay(page: Page): Promise<void> {
  const link = {
    mode: "relay",
    relayUrl: "wss://relay.custom.invalid",
    directUrl: "",
    hostId: "a".repeat(26),
    hostKey: "A".repeat(43),
    loopbackUrl: "",
    token: "",
  };
  await page.addInitScript((value) => localStorage.setItem("doriface.connection", value), JSON.stringify(link));
}

test("Settings > This device offers no relay address to edit and no Loopback dev switch", async ({ page }) => {
  await saveCustomRelay(page);
  // Nothing in this spec leaves the browser: the production relay is answered here and closes at once.
  await page.routeWebSocket(PRODUCTION, (ws) => ws.close());
  await page.goto("/settings");
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "This device" }).click();
  await expect(page.getByText("relay-doriface.omo.dev", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /relay/i })).toHaveCount(0);
  await expect(page.getByText("Loopback dev")).toHaveCount(0);
  await expect(page.getByText("relay.custom.invalid")).toHaveCount(0);
});

test("a link to this computer offers its gateway but no Connect through switch either", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "This device" }).click();
  await expect(page.getByRole("textbox", { name: "Gateway", exact: true })).toBeVisible();
  await expect(page.getByLabel("Connect through")).toHaveCount(0);
  await expect(page.getByText("Loopback dev")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: /relay/i })).toHaveCount(0);
});

test("with a custom relay address saved, the app dials the production relay and never the saved one", async ({
  page,
}) => {
  await saveCustomRelay(page);
  const dialled: string[] = [];
  const production = new Promise<string>((resolve) => {
    void page.routeWebSocket(PRODUCTION, (ws) => {
      dialled.push(ws.url());
      resolve(ws.url());
      ws.close();
    });
  });
  await page.routeWebSocket(CUSTOM, (ws) => {
    dialled.push(ws.url());
    ws.close();
  });
  await page.goto("/");
  expect(await production).toMatch(new RegExp(`/v1/client/${"a".repeat(26)}`));
  expect(dialled.filter((url) => CUSTOM.test(url))).toEqual([]);
});

// The locked section in both themes at 1440 and 390: CAPTURE=1 CAPTURE_DIR=<dir> bunx playwright test connection-relay-locked
test.describe("capture", () => {
  test.skip(process.env["CAPTURE"] !== "1", "captures run only with CAPTURE=1");
  const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
  for (const width of ["1440", "390"] as const) {
    for (const scheme of ["light", "dark"] as const) {
      test(`Connections at ${width} in ${scheme}`, async ({ browser }, info) => {
        const size = width === "1440" ? { viewport: { width: 1440, height: 900 } } : phone;
        const context = await browser.newContext({ ...size, colorScheme: scheme });
        const page = await context.newPage();
        await saveCustomRelay(page);
        await page.routeWebSocket(PRODUCTION, (ws) => ws.close());
        await page.goto("/settings");
        await (
          width === "1440"
            ? page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "This device" })
            : page.getByRole("tab", { name: "This device" })
        ).click();
        await expect(page.getByText("relay-doriface.omo.dev", { exact: true })).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        const out = process.env["CAPTURE_DIR"] ?? info.outputPath();
        await page.screenshot({ path: join(out, `connections-${width}-${scheme}.png`), animations: "disabled" });
        await context.close();
      });
    }
  }
});
