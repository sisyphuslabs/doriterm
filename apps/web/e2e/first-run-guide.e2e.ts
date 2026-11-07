// #668: a phone opens the link a host's pairing QR code carries (#700), lands on /pair with the link already captured, pairs,
// and the first-run steps then complete in order on their own events: the pairing, a terminal shown on this device,
// and that terminal in the agents list. The guide can be skipped, and Settings opens it again.
import { devices, type Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { type FakeRelayHost, startFakeRelayHost } from "./relay-route.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ ...phone, serviceWorkers: "block" });

const guide = (page: Page) => page.getByRole("region", { name: "Getting started" });

async function stepStates(page: Page): Promise<string[]> {
  return guide(page)
    .locator("[data-step]")
    .evaluateAll((items) =>
      items.map((item) => `${item.getAttribute("data-step")}:${item.getAttribute("data-state")}`),
    );
}

/** Opens the QR code's link as a phone camera hands it to the browser, and pairs on it. */
async function pairFromQrLink(page: Page, host: FakeRelayHost): Promise<void> {
  await host.route(page);
  const link = await host.pairingLink();
  expect(new URL(link).pathname).toBe("/pair");
  const secret = new URLSearchParams(new URL(link).hash.slice(1)).get("p") ?? "";
  expect(secret).toHaveLength(43);
  await page.goto(link);
  // Prefilled: the verify step is showing this link's host, and the secret already left the address bar.
  await expect(page.getByRole("button", { name: "They match" })).toBeVisible({ timeout: 30_000 });
  expect(new URL(page.url()).pathname).toBe("/pair");
  expect(page.url()).not.toContain(secret);
  await page.getByRole("button", { name: "They match" }).click();
  await expect(page.getByRole("status").getByText("Paired")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("link", { name: "Open terminals" }).click();
  await expect(guide(page)).toBeVisible({ timeout: 60_000 });
}

test("from the QR code's link, the first-run steps complete in order on their real events", async ({ page }) => {
  test.setTimeout(180_000);
  const host = await startFakeRelayHost();
  try {
    await pairFromQrLink(page, host);
    await expect(guide(page)).toBeVisible();
    await expect.poll(() => stepStates(page)).toEqual(["pair:done", "agent:current", "list:todo"]);

    await guide(page).getByRole("button", { name: "Start a terminal" }).click();
    await expect(page.getByRole("button", { name: "Back to agents" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Back to agents" }).click();
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
    await expect.poll(() => stepStates(page), { timeout: 30_000 }).toEqual(["pair:done", "agent:done", "list:done"]);
    await expect(guide(page).getByRole("heading", { name: "You're set" })).toBeVisible();
    await guide(page).getByRole("button", { name: "Done" }).click();
    await expect(guide(page)).toHaveCount(0);

    // Settings opens it again, from the step after pairing.
    await page.getByRole("link", { name: /^Settings/ }).click();
    await page.getByRole("tab", { name: "Device" }).click();
    await page.getByRole("link", { name: "Show again" }).click();
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
    await expect.poll(() => stepStates(page)).toEqual(["pair:done", "agent:current", "list:todo"]);
  } finally {
    await host.stop();
  }
});

test("the list step waits for the terminal this device opened, not the host's own shell (#834)", async ({ page }) => {
  test.setTimeout(180_000);
  const host = await startFakeRelayHost({ terminal: true });
  try {
    await pairFromQrLink(page, host);
    await expect.poll(() => stepStates(page)).toEqual(["pair:done", "agent:current", "list:todo"]);
    // The card says the current step out loud, through a polite status line.
    const status = guide(page).getByRole("status");
    const currentLabel = await guide(page)
      .locator('[aria-current="step"]')
      .evaluate((item) =>
        [...item.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent)
          .join("")
          .trim(),
      );
    await expect(status).toContainText(currentLabel);

    // This device starts a terminal and ends it; the host's own shell, `existing`, stays live.
    await guide(page).getByRole("button", { name: "Start a terminal" }).click();
    await expect(page.locator("[data-terminal]")).toContainText("$", { timeout: 30_000 });
    await page.keyboard.type("exit");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Back to agents" })).toHaveCount(0, { timeout: 30_000 });
    const existing = page.getByText("existing", { exact: true }).first();
    await expect(existing).toBeVisible({ timeout: 30_000 });
    expect(await stepStates(page)).toEqual(["pair:done", "agent:done", "list:current"]);

    // Opening the host's shell makes it the terminal the step waits for, and it is listed live.
    await existing.click();
    await page.getByRole("button", { name: "Back to agents" }).click();
    await expect.poll(() => stepStates(page), { timeout: 30_000 }).toEqual(["pair:done", "agent:done", "list:done"]);
    await expect(status).toContainText(await guide(page).getByRole("heading").innerText());
  } finally {
    await host.stop();
  }
});

test("Skip puts the guide away", async ({ page }) => {
  test.setTimeout(180_000);
  const host = await startFakeRelayHost();
  try {
    await pairFromQrLink(page, host);
    await expect(guide(page)).toBeVisible();
    await guide(page).getByRole("button", { name: "Skip" }).click();
    await expect(guide(page)).toHaveCount(0);
  } finally {
    await host.stop();
  }
});

test.describe("on a desktop, with a terminal the host already had", () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

  test("the agent step waits for this device to open one, whatever the restored layout shows", async ({ page }) => {
    test.setTimeout(180_000);
    const host = await startFakeRelayHost({ terminal: true });
    try {
      await pairFromQrLink(page, host);
      const existing = page.getByRole("complementary", { name: "Workspace" }).getByText("existing").first();
      await expect(existing).toBeVisible({ timeout: 30_000 });
      // The restored layout puts the host's own shell in focus, and that completes nothing.
      await expect(page.locator('[data-focused="true"] [data-terminal]')).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => stepStates(page)).toEqual(["pair:done", "agent:current", "list:todo"]);
      await existing.click();
      await expect.poll(() => stepStates(page), { timeout: 30_000 }).toEqual(["pair:done", "agent:done", "list:done"]);
    } finally {
      await host.stop();
    }
  });
});
