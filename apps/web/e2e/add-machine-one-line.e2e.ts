// #668: Add a machine is one command. The dialog asks this host for a single-use mesh offer and shows the line to run on
// the machine to add; running what that line runs (doriface-host mesh join with its link) on a second machine admits it
// to this host's mesh, which the host writes back and the dialog reports with no second step. Each host keeps its own
// uplink on the fake relay, so clients can reach the joiner directly.
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

test("the dialog's one line, run on a second machine, joins it to this host's mesh and the dialog says so", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const host = await startFakeRelayHost();
  try {
    await pair(page, host);
    await page.getByRole("button", { name: "Add machine" }).click({ timeout: 60_000 });
    const dialog = page.getByRole("dialog", { name: "Add a machine" });
    const command = dialog.getByLabel("Join command");
    await expect(command).toBeVisible({ timeout: 30_000 });
    const text = (await command.innerText()).trim();
    const match =
      /^curl -fsSL https:\/\/github\.com\/sisyphuslabs\/doriterm\/releases\/latest\/download\/install\.sh \| sh -s -- --join '(doriface:\/\/pair#[^']+)'$/.exec(
        text,
      );
    const link = match?.[1] ?? "";
    expect(new URLSearchParams(link.split("#")[1]).get("m")).toBe("1");
    await expect(dialog.getByRole("status")).toContainText("Waiting for the machine to join");

    expect(await host.join(link)).toBe("joiner");
    await expect(dialog.getByText("joiner joined this host's mesh")).toBeVisible({ timeout: 60_000 });
    // The hand-run steps are still there, folded under Advanced.
    await dialog.getByText("Advanced: pair and add by hand").click();
    await expect(dialog.getByText("doriface-host pair", { exact: true })).toBeVisible();
  } finally {
    await host.stop();
  }
});
