import { expect, test } from "./fixtures.ts";
import { openSettingsSection } from "./settings-sections.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

/** A loopback port nothing listens on: the browser reports the refused link as close code 1006. */
test.use({ loopbackUrl: "ws://127.0.0.1:1/v1/hc" });

const CAUSE = "Your host isn't answering. Check that its computer is on and doriface-host is running.";

for (const width of [1440, 390]) {
  test(`at ${width} px, Settings says in words why the host cannot be reached, and the close code stays in Details (#477)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/settings");
    // A phone opens on the list of sections; the host's state is on This device (#2914).
    await openSettingsSection(page, "This device");
    await expect(page.getByText(CAUSE).filter({ visible: true }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/\(1006\)/).filter({ visible: true })).toHaveCount(0);
  });
}
