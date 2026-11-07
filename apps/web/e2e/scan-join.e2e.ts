import type { Browser, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { type FakeRelayHost, startFakeRelayHost } from "./relay-route.ts";

test.use({ serviceWorkers: "block" });

const INVITE = /invite link a member sent you/;

async function freshBrowser(browser: Browser, host: FakeRelayHost): Promise<Page> {
  const page = await (await browser.newContext({ serviceWorkers: "block" })).newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  await host.route(page);
  return page;
}

test("a phone that cannot receive a link scans the host's QR and joins", async ({ browser }) => {
  test.setTimeout(180_000);
  const host = await startFakeRelayHost({ machine: true });
  try {
    const invite = await host.pairingLink();
    const page = await freshBrowser(browser, host);
    await page.addInitScript((link: string) => {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      const context = canvas.getContext("2d");
      context?.fillRect(0, 0, 64, 64);
      const stream = canvas.captureStream(5);
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: { getUserMedia: () => Promise.resolve(stream) },
      });
      let reads = 0;
      class FakeBarcodeDetector {
        static getSupportedFormats(): Promise<string[]> {
          return Promise.resolve(["qr_code"]);
        }
        detect(): Promise<{ rawValue: string }[]> {
          reads += 1;
          return Promise.resolve(reads > 1 ? [{ rawValue: link }] : []);
        }
      }
      Object.defineProperty(globalThis, "BarcodeDetector", { configurable: true, value: FakeBarcodeDetector });
    }, invite);

    await page.goto("/");
    await expect(page.getByText(INVITE)).toBeVisible({ timeout: 30_000 });
    await page
      .getByRole("link", { name: "Pair a host" })
      .or(page.getByRole("button", { name: "Pair a host" }))
      .click();
    await page.getByRole("button", { name: "Scan the QR code" }).click();
    await expect(page.getByRole("figure").filter({ hasText: "Host key (SHA-256)" })).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "They match" }).click();
    await expect(page.getByText("This device now reaches the host through the relay")).toBeVisible({ timeout: 90_000 });
  } finally {
    await host.stop();
  }
});
