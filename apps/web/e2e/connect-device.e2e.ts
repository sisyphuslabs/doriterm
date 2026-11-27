// #2939: one place to connect anything. A phone or browser gets an invite as a QR and an https link it can open; the
// link it gives is the hosted app's join page, never the desktop app's own scheme, which a phone cannot open.
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

test("Connect a device opens on a phone or browser invite: a QR and an https link that opens Join this mesh", async ({
  page,
  browser,
  baseURL,
}) => {
  await page.goto("/");
  const footer = page.getByRole("complementary", { name: "Workspace" }).locator('[data-slot="sidebar-footer"]');
  await footer.getByRole("button", { name: "Connect a device" }).click({ timeout: 60_000 });
  const dialog = page.getByRole("dialog", { name: "Connect a device" });
  await expect(dialog.getByRole("img", { name: "Invite QR code" })).toBeVisible({ timeout: 20_000 });
  const link = (await dialog.getByLabel("Invite link").textContent()) ?? "";
  expect(link).toMatch(/^https:\/\/[^/]+\/pair#.*m=1/);
  // The link's own page is the hosted app; this run serves the app locally, so the fragment is opened here.
  const phone = await browser.newContext(baseURL === undefined ? {} : { baseURL });
  try {
    const opened = await phone.newPage();
    await opened.goto(`/pair${link.slice(link.indexOf("#"))}`);
    await expect(opened.getByRole("heading", { name: "Join this mesh" })).toBeVisible({ timeout: 20_000 });
  } finally {
    await phone.close();
  }
});

// The sheet on a phone (#2949 review): a computer's tab is the tallest; it stays a bounded scroller inside the viewport,
// and its Done stays reachable at the end, at 390 and at 320.
for (const width of [390, 320] as const) {
  test(`at ${width} the Computer tab stays inside the screen and its Done stays in view`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/settings#machines");
    await page.getByRole("button", { name: "Connect a device" }).first().click({ timeout: 60_000 });
    const dialog = page.getByRole("dialog", { name: "Connect a device" });
    await dialog.getByRole("button", { name: "Computer", exact: true }).click();
    await expect(dialog.getByLabel("Join command")).toBeVisible({ timeout: 20_000 });
    const box = await dialog.boundingBox();
    expect(
      box === null ? "no box" : box.y >= 0 && box.y + box.height <= 844 && box.x >= 0 && box.x + box.width <= width,
    ).toBe(true);
    await dialog.evaluate((element) => element.scrollTo(0, element.scrollHeight));
    await expect(dialog.getByRole("button", { name: "Done" })).toBeInViewport();
  });
}

// #2949 review: a phone invite, then the Computer tab at once. Both tabs ask for an offer through one document; the
// computer's request must win and show its command, never "No join command" or a phone request answered instead.
test("asking for a phone invite and then a computer's command shows the command", async ({ page }) => {
  await page.goto("/");
  const footer = page.getByRole("complementary", { name: "Workspace" }).locator('[data-slot="sidebar-footer"]');
  await footer.getByRole("button", { name: "Connect a device" }).click({ timeout: 60_000 });
  const dialog = page.getByRole("dialog", { name: "Connect a device" });
  await expect(dialog.getByRole("img", { name: "Invite QR code" })).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole("button", { name: "Computer", exact: true }).click();
  await expect(dialog.getByLabel("Join command")).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByText("No join command")).toHaveCount(0);
});

// The AI agent tab needs this computer's pairing offer, which the desktop shell relays; a browser run has no shell, so
// these cases stand one in that answers with a live offer.
const stubPairBridge = (page: Page) =>
  page.addInitScript(() => {
    const offer = {
      code: "JYQZVBSS",
      link: "doriface://pair#h=4belvqxk2mja7ntd3r5c6wyezu&k=Q2pX0n&s=ab&r=wss%3A%2F%2Frelay.doriterm.com",
      opens: "desktop",
      hostId: "4belvqxk2mja7ntd3r5c6wyezu",
      fingerprint: "3FA9 4C0E 7B21 D855",
      expiresAt: Date.now() + 600_000,
      slot: "registered",
      codeUsable: true,
    };
    Object.assign(window, { doriface: { pairOffer: async () => ({ state: "pending", offer }) } });
  });

const openAgentTab = async (page: Page, path: string) => {
  await page.goto(path);
  await page.getByRole("button", { name: "Connect a device" }).first().click({ timeout: 60_000 });
  const dialog = page.getByRole("dialog", { name: "Connect a device" });
  await dialog.getByRole("button", { name: "AI agent", exact: true }).click();
  await expect(dialog.getByLabel("OmO prompt")).toBeVisible({ timeout: 20_000 });
  return dialog;
};

test("the AI agent tab leads with OmO, then any other agent's prompt, then the agents set up by hand", async ({
  page,
}) => {
  await stubPairBridge(page);
  const dialog = await openAgentTab(page, "/");
  const order = await dialog
    .locator("h3")
    .evaluateAll((headings) => headings.map((heading) => heading.textContent?.trim()));
  expect(order.slice(0, 3)).toEqual(["OmO", "Any other agent", "Or set it up by hand"]);
  await expect(dialog.getByRole("region", { name: "OmO" })).toContainText("~/.omo/agent/mcp.json");
  await expect(dialog.getByText(/one-time pairing secret: it works once, for 10 minutes/)).toBeVisible();
  // One segment is the active one: pressed, and the only one filled once its colour transition has run.
  const segments = dialog.getByRole("group", { name: "What to connect" }).getByRole("button");
  await expect(segments.filter({ hasText: "AI agent" })).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() => segments.evaluateAll((all) => all.map((each) => getComputedStyle(each).backgroundColor)))
    .toEqual(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)", expect.not.stringMatching(/^rgba\(0, 0, 0, 0\)$/)]);
});

for (const width of [390, 320] as const) {
  test(`at ${width} the AI agent tab is a sheet down to the bottom edge, with Done in view at its end`, async ({
    page,
  }) => {
    await stubPairBridge(page);
    await page.setViewportSize({ width, height: 844 });
    const dialog = await openAgentTab(page, "/settings#machines");
    const box = await dialog.boundingBox();
    expect(box === null ? "no box" : [box.x, box.width, Math.round(box.y + box.height)]).toEqual([0, width, 844]);
    await dialog.evaluate((element) => element.scrollTo(0, element.scrollHeight));
    await expect(dialog.getByRole("button", { name: "Done" })).toBeInViewport();
  });
}
