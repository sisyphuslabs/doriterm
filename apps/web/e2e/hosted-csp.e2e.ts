import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { E2E_HOST_PORT } from "./config.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";

// #777: the hosted app's Content Security Policy (public/_headers) holds through a terminal, an image paste, Settings
// with a download, and the pair page: the page reports no violation. The preview server sends no headers, so each
// document is served here with that policy; its connect-src gains only this run's loopback host, which stands in for
// the relay the hosted app dials.
// A document Playwright fulfils has no local address, so Chromium's local network access check would refuse its dial to
// the loopback host; the hosted app dials a public relay, which that check never stops.
test.use({
  serviceWorkers: "block",
  launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] },
  // The pinned e2e faces (#862) arrive as an injected <style> with data: URLs, which this spec's policy does not allow:
  // they would be a violation of the very CSP under test. The page's fonts are not this spec's subject.
  pinnedFonts: false,
});

function hostedPolicy(): string {
  const headers = readFileSync(join(import.meta.dirname, "..", "public", "_headers"), "utf8");
  const policy = /^\/\*\n(?:  .*\n)*?  Content-Security-Policy: (.+)$/m.exec(headers)?.[1];
  if (policy === undefined) throw new Error("public/_headers has no Content-Security-Policy for /*");
  const host = `127.0.0.1:${E2E_HOST_PORT}`;
  return policy.replace("connect-src 'self'", `connect-src 'self' http://${host} ws://${host}`);
}

async function serveUnderPolicy(page: Page): Promise<void> {
  const policy = hostedPolicy();
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": policy } });
  });
  await page.addInitScript(() => {
    const seen: string[] = [];
    Reflect.set(window, "__cspViolations", seen);
    document.addEventListener("securitypolicyviolation", (event) => {
      seen.push(`${event.effectiveDirective} ${event.blockedURI}`);
    });
  });
}

const violations = (page: Page): Promise<unknown> => page.evaluate(() => Reflect.get(window, "__cspViolations"));

test("the hosted policy reports no violation in a terminal, an image paste, Settings' download and the pair page", async ({
  page,
}) => {
  await serveUnderPolicy(page);
  await page.goto("/");
  await expect(page.getByRole("contentinfo").or(page.getByText("Cannot reach your host"))).toBeVisible();
  expect(await violations(page)).toEqual([]);
  const terminal = await openNewTerminal(page);
  await page.keyboard.type("echo csp-$((6*7))\r");
  await expect(terminal).toContainText("csp-42");

  await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(8, 8);
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("no canvas");
    context.fillRect(0, 0, 8, 8);
    const data = new DataTransfer();
    data.items.add(new File([await canvas.convertToBlob({ type: "image/png" })], "image.png", { type: "image/png" }));
    const target = document.activeElement ?? document.body;
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(terminal).toContainText("doriface-paste-", { timeout: 30_000 });
  await page.keyboard.press("Control+C");
  expect(await violations(page)).toEqual([]);

  await page.goto("/settings");
  await page.getByRole("button", { name: "Keybindings" }).first().click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/^ghostty-keybinds/);
  expect(await violations(page)).toEqual([]);

  await page.goto("/pair");
  await expect(page.getByRole("heading").first()).toBeVisible();
  expect(await violations(page)).toEqual([]);
});
