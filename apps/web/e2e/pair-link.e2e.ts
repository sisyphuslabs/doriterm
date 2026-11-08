import { BAD_LINK, MESH_LINK, PAIR_LINK } from "./capture-relay.ts";
import { expect, test } from "./fixtures.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

test("a mesh invite opens browser membership and keeps the computer command in details", async ({ page }) => {
  await page.goto(MESH_LINK);
  await expect(page.getByRole("heading", { name: "Join this mesh" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Join", exact: true })).toBeVisible();
  await page.getByText("I meant to add a computer", { exact: true }).click();
  await expect(page.locator("code").filter({ hasText: "doriface-host mesh join <link>" })).toBeVisible();
  await expect(page.getByRole("button", { name: "They match" })).toHaveCount(0);
});

test("an unusable pairing link leads to the mesh invite entry", async ({ page }) => {
  await page.goto(BAD_LINK);
  await expect(page.getByText("This pairing link cannot be used")).toBeVisible();
  await page.getByRole("link", { name: "Enter an invite" }).click();
  await expect(page.getByRole("heading", { name: "Join a mesh" })).toBeVisible();
  await expect(page.getByLabel("Invite link or code")).toBeVisible();
});

for (const [kind, link, command] of [
  ["mesh", `${BAD_LINK}&m=1`, "doriface-host mesh pair"],
  ["device", BAD_LINK, "doriface-host pair"],
] as const) {
  test(`an unusable ${kind} link names the command that makes a new one (#727)`, async ({ page }) => {
    await page.goto(link);
    await expect(page.locator("code").filter({ hasText: new RegExp(`^${command}$`) })).toBeVisible();
  });
}

test("a pairing link's secret leaves the address bar and the history on load", async ({ page }) => {
  const secret = new URLSearchParams(PAIR_LINK.split("#")[1]).get("p") ?? "";
  expect(secret).toHaveLength(43);
  const sent: string[] = [];
  page.on("request", (request) => sent.push(request.url(), request.headers()["referer"] ?? ""));
  await page.goto(PAIR_LINK);
  // The link still pairs: it reached the step that compares the host key.
  await expect(page.getByRole("button", { name: "They match" })).toBeVisible();
  expect(page.url()).not.toContain(secret);
  const cdp = await page.context().newCDPSession(page);
  const { entries } = await cdp.send("Page.getNavigationHistory");
  expect(entries.map((entry) => entry.url).filter((url) => url.includes(secret))).toEqual([]);
  expect(sent.filter((line) => line.includes(secret))).toEqual([]);
});
