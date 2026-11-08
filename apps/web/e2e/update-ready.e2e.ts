import type { Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "./fixtures.ts";

test.use({ viewport: { width: 1440, height: 900 } });

/**
 * The e2e web build behind a proxy on its own origin (so its service worker is this spec's alone). After `deploy()` its
 * /sw.js carries one more line: to the browser, the next build's worker. Neither Playwright's routes nor CDP's Fetch
 * see a worker's own update check, so the change has to come from the server.
 */
async function deployableSite(upstream: string): Promise<{ url: string; deploy(): void; close(): Promise<void> }> {
  let deployed = false;
  const server: Server = createServer((request, response) => {
    void (async () => {
      const answer = await fetch(new URL(request.url ?? "/", upstream));
      const body = Buffer.from(await answer.arrayBuffer());
      const next = deployed && (request.url ?? "").startsWith("/sw.js");
      response.writeHead(answer.status, {
        "content-type": answer.headers.get("content-type") ?? "application/octet-stream",
        "cache-control": "no-cache",
      });
      response.end(next ? Buffer.concat([body, Buffer.from("\n// the next build\n")]) : body);
    })().catch((error: unknown) => {
      response.writeHead(502);
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    deploy: () => {
      deployed = true;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const registration = (page: Page): Promise<{ readonly controlled: boolean; readonly waiting: boolean }> =>
  page.evaluate(async () => {
    const found = await navigator.serviceWorker.getRegistration();
    return { controlled: navigator.serviceWorker.controller !== null, waiting: (found?.waiting ?? null) !== null };
  });

test("a waiting service worker lights the Settings dot, and Reload to update applies it (#217)", async ({
  page,
  baseURL,
}) => {
  const site = await deployableSite(baseURL ?? "");
  try {
    await page.goto(site.url);
    const settings = page.getByRole("complementary", { name: "Workspace" }).getByRole("link", { name: /^Settings\b/ });
    await expect(settings).toHaveAccessibleName("Settings", { timeout: 20_000 });
    await expect.poll(() => registration(page), { timeout: 20_000 }).toEqual({ controlled: true, waiting: false });

    site.deploy();
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration())?.update();
    });

    await expect(settings).toHaveAccessibleName("Settings, update ready", { timeout: 20_000 });
    expect(await registration(page)).toEqual({ controlled: true, waiting: true });

    await settings.click();
    await expect(page).toHaveURL(/\/settings$/);
    await page.evaluate(() => Reflect.set(window, "beforeReload", true));
    const reloaded = page.waitForEvent("load", { timeout: 20_000 });
    await page.getByRole("button", { name: "Reload to update" }).click();
    await reloaded;

    // The page reloaded under the worker that waited: none waits any more, and nothing is left to update.
    expect(await page.evaluate(() => Reflect.get(window, "beforeReload") ?? false)).toBe(false);
    await expect.poll(() => registration(page), { timeout: 20_000 }).toEqual({ controlled: true, waiting: false });
    await expect(page.getByRole("button", { name: "Reload to update" })).toHaveCount(0);
  } finally {
    await site.close();
  }
});

test.describe("on the phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a waiting service worker lights the dot on the bottom tabs' Settings (#422, #1387)", async ({
    page,
    baseURL,
  }) => {
    const site = await deployableSite(baseURL ?? "");
    try {
      await page.goto(site.url);
      const settings = page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: /^Settings\b/ });
      await expect(settings).toHaveAccessibleName("Settings", { timeout: 20_000 });
      await expect(settings.locator('[data-slot="settings-dot"]')).toHaveCount(0);
      await expect.poll(() => registration(page), { timeout: 20_000 }).toEqual({ controlled: true, waiting: false });

      site.deploy();
      await page.evaluate(async () => {
        await (await navigator.serviceWorker.getRegistration())?.update();
      });
      await expect(settings).toHaveAccessibleName("Settings, update ready", { timeout: 20_000 });
      await expect(settings.locator('[data-slot="settings-dot"]')).toHaveCount(1);
    } finally {
      await site.close();
    }
  });
});
