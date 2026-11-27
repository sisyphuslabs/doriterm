// #2795, #2939: connecting a computer and pairing a host are one flow. The same dialog shows the line to run on the other machine AND takes
// an invite for this side; this app's own line pasted back is refused before any handshake, so it still works where it
// belongs: in the other machine's terminal.
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { type FakeRelayHost, startFakeRelayHost } from "./relay-route.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

async function pair(page: Page, host: FakeRelayHost): Promise<void> {
  await host.route(page);
  await page.goto(await host.pairingLink());
  await page.getByRole("button", { name: "They match" }).click({ timeout: 30_000 });
  await page.getByRole("link", { name: "Open terminals" }).click({ timeout: 30_000 });
}

async function openConnectSheet(page: Page) {
  await page.getByRole("button", { name: "Connect a device" }).click({ timeout: 60_000 });
  const dialog = page.getByRole("dialog", { name: "Connect a device" });
  // A computer joins from the Computer tab; the sheet opens on a phone or browser.
  await dialog.getByRole("button", { name: "Computer", exact: true }).click();
  const command = dialog.getByLabel("Join command");
  await expect(command).toBeVisible({ timeout: 30_000 });
  return { dialog, line: (await command.innerText()).trim() };
}

test("this app's own line pasted back into its invite field is refused, and still joins from the other machine", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const host = await startFakeRelayHost();
  try {
    await pair(page, host);
    const { dialog, line } = await openConnectSheet(page);
    await dialog.getByLabel("Invite link or code").fill(line);
    await dialog.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(dialog.getByText(/This is this app's invite for adding another machine/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Join this mesh", exact: true })).toHaveCount(0);
    // Not spent: the same line, run where it belongs, joins.
    const link = /DORIFACE_JOIN='(doriface:\/\/pair#[^']+)'/.exec(line)?.[1] ?? "";
    expect(await host.join(link)).toBe("joiner");
    await expect(dialog.getByText("joiner joined this host's mesh")).toBeVisible({ timeout: 60_000 });
  } finally {
    await host.stop();
  }
});

test("the same dialog takes an invite from another machine and opens it for this side", async ({ page }) => {
  test.setTimeout(240_000);
  const host = await startFakeRelayHost();
  const other = await startFakeRelayHost();
  try {
    await pair(page, host);
    await other.route(page);
    const { link } = await other.meshOffer();
    const { dialog } = await openConnectSheet(page);
    await dialog
      .getByLabel("Invite link or code")
      .fill(`curl -fsSL https://get.doriterm.com | DORIFACE_JOIN='<${link}>' sh`);
    await dialog.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Join this mesh", exact: true })).toBeVisible({ timeout: 30_000 });
  } finally {
    await other.stop();
    await host.stop();
  }
});
