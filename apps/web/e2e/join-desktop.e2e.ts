import type { BrowserContext } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { type FakeRelayHost, startFakeRelayHost } from "./relay-route.ts";

test.use({ serviceWorkers: "block" });

const INVITE = /invite link a member sent you/;
const PAIRED = "This device now reaches the host through the relay";
const FINGERPRINT = { hasText: "Host key (SHA-256)" };

async function desktopPage(context: BrowserContext, host: FakeRelayHost) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await host.route(page);
  return page;
}

async function pairScreen(page: Awaited<ReturnType<typeof desktopPage>>): Promise<void> {
  await expect(page.getByText(INVITE)).toBeVisible({ timeout: 30_000 });
  await page
    .getByRole("link", { name: "Pair a host" })
    .or(page.getByRole("button", { name: "Pair a host" }))
    .click();
}

async function confirmAndPair(page: Awaited<ReturnType<typeof desktopPage>>): Promise<void> {
  await expect(page.getByRole("figure").filter(FINGERPRINT)).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "They match" }).click();
  await expect(page.getByText(PAIRED)).toBeVisible({ timeout: 90_000 });
  // A join is not finished at the paired notice: the person opens the terminals, and the first-run guide is what a newly
  // joined device sees there (#723). Each path in - link, paste, code - has to arrive at it, not only the QR link
  // first-run-guide.e2e.ts drives from a phone.
  await page.getByRole("link", { name: "Open terminals" }).click();
  await expect(page.getByRole("region", { name: "Getting started" })).toBeVisible({ timeout: 60_000 });
}

test("a desktop browser joins by clicking the invite link", async ({ browser }) => {
  test.setTimeout(180_000);
  const host = await startFakeRelayHost({ machine: true });
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    const { link } = await host.pairingOffer();
    const page = await desktopPage(context, host);
    await page.goto(link);
    await confirmAndPair(page);
  } finally {
    await context.close();
    await host.stop();
  }
});

test("a desktop browser joins by pasting the invite link", async ({ browser }) => {
  test.setTimeout(180_000);
  const host = await startFakeRelayHost({ machine: true });
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    const { link } = await host.pairingOffer();
    const page = await desktopPage(context, host);
    await page.goto("/");
    await pairScreen(page);
    await page.getByRole("textbox").first().fill(link);
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await confirmAndPair(page);
  } finally {
    await context.close();
    await host.stop();
  }
});

test("a desktop browser joins by typing the code the host shows", async ({ browser }) => {
  test.setTimeout(180_000);
  const host = await startFakeRelayHost({ machine: true });
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    const { code } = await host.pairingOffer();
    const page = await desktopPage(context, host);
    await page.goto("/");
    await pairScreen(page);
    await page
      .getByRole("textbox")
      .first()
      .fill(`${code.slice(0, 4)} ${code.slice(4)}`);
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await confirmAndPair(page);
  } finally {
    await context.close();
    await host.stop();
  }
});
