import type { BrowserContext } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { type FakeRelayHost, startFakeRelayHost } from "./relay-route.ts";

test.use({ serviceWorkers: "block" });

const PAIRED = "This device now reaches the host through the relay";
const FINGERPRINT = { hasText: "Host key (SHA-256)" };

async function desktopPage(context: BrowserContext, host: FakeRelayHost) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await host.route(page);
  return page;
}

async function inviteScreen(page: Awaited<ReturnType<typeof desktopPage>>): Promise<void> {
  await expect(page.getByRole("heading", { name: "Join a mesh", exact: true })).toBeVisible();
  await expect(page.getByLabel("Invite link or code")).toBeVisible();
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

test("a desktop browser keeps legacy fingerprint verification when opening a device invite link", async ({
  browser,
}) => {
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

test("a desktop browser keeps legacy fingerprint verification when pasting a device invite link", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const host = await startFakeRelayHost({ machine: true });
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    const { link } = await host.pairingOffer();
    const page = await desktopPage(context, host);
    await page.goto("/");
    await inviteScreen(page);
    await page.getByLabel("Invite link or code").fill(link);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page).toHaveURL(/\/pair$/);
    const secret = new URLSearchParams(new URL(link).hash.slice(1)).get("p");
    if (secret === null) throw new Error("the device invite has no link secret");
    expect(await page.evaluate(() => JSON.stringify(history.state ?? null))).not.toContain(secret);
    await confirmAndPair(page);
  } finally {
    await context.close();
    await host.stop();
  }
});

test("a desktop browser still pairs by typing the code doriface-host pair shows", async ({ browser }) => {
  test.setTimeout(180_000);
  const host = await startFakeRelayHost({ machine: true });
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    const { code } = await host.pairingOffer();
    const page = await desktopPage(context, host);
    await page.goto("/pair");
    await inviteScreen(page);
    await page.getByLabel("Invite link or code").fill(`${code.slice(0, 4)} ${code.slice(4)}`);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("button", { name: "Join", exact: true }).click();
    await confirmAndPair(page);
  } finally {
    await context.close();
    await host.stop();
  }
});

test("typing a mesh code looks its host up from the third character on, and Continue asks nothing more (#1271)", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const host = await startFakeRelayHost({ machine: true });
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    const { code } = await host.meshOffer();
    const page = await desktopPage(context, host);
    const lookups: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/v1/pair/")) lookups.push(request.url());
    });
    await page.goto("/");
    await inviteScreen(page);
    const field = page.getByLabel("Invite link or code");
    await field.pressSequentially(code.slice(0, 3));
    await expect.poll(() => lookups.length).toBe(1);
    await field.pressSequentially(code.slice(3));
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("button", { name: "Join", exact: true }).click();
    await expect(page.getByLabel("Join code")).toBeVisible();
    expect(lookups).toHaveLength(1);
  } finally {
    await context.close();
    await host.stop();
  }
});

test("the pair route joins a mesh with a typed code and both confirmations", async ({ browser }, info) => {
  test.setTimeout(180_000);
  const host = await startFakeRelayHost({ machine: true });
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    const { code } = await host.meshOffer();
    const page = await desktopPage(context, host);
    await page.goto("/pair");
    await inviteScreen(page);
    await page.getByLabel("Invite link or code").fill(`${code.slice(0, 4)} ${code.slice(4)}`);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("button", { name: "Join", exact: true }).click();
    await expect(page.getByLabel("Join code")).toBeVisible();
    const pending = await host.pendingJoin();
    await expect(page.getByLabel("Join code")).toHaveText(pending.code);
    await host.answerJoin(pending.nonce, pending.code, true);
    await page.getByRole("button", { name: "The codes match", exact: true }).click();
    await expect(page).toHaveURL(/\/settings#machines$/);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page.getByRole("region", { name: "Getting started" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("this machine", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("typed-membership-workspace.png"), fullPage: true });
  } finally {
    await context.close();
    await host.stop();
  }
});
