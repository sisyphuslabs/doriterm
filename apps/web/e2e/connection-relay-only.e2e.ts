// #458: the direct-address feature is hidden. Settings > This device offers no Direct address and shows the relay with
// no field to edit it, in a release build and in a dev build (E2E_WEB_MODE=development), and adding a machine offers
// only the relay path. A dev build still reads another relay and the direct address from saved settings.
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

test.use({ serviceWorkers: "block" });

const DEV_BUILD = process.env["E2E_WEB_MODE"] === "development";
// Any port: a session's second and third sockets dial the relay's other HTTPS ports (#1418).
const PRODUCTION = /^wss:\/\/relay-doriface\.omo\.dev(:\d+)?\//;
const CUSTOM = /^wss:\/\/relay\.custom\.invalid(:\d+)?\//;
const DIRECT = "ws://192.168.1.20:7767";

/** A host paired over a custom relay, with a direct address saved, as an older build or a developer leaves them. */
async function saveRelayLink(page: Page): Promise<void> {
  const link = {
    mode: "relay",
    relayUrl: "wss://relay.custom.invalid",
    directUrl: DIRECT,
    hostId: "a".repeat(26),
    hostKey: "A".repeat(43),
    loopbackUrl: "",
    token: "",
  };
  await page.addInitScript((value) => localStorage.setItem("doriface.connection", value), JSON.stringify(link));
  // Nothing here leaves the browser: either relay is answered here and closes at once.
  await Promise.all([PRODUCTION, CUSTOM].map((relay) => page.routeWebSocket(relay, (ws) => ws.close())));
}

test("Settings > This device has no Direct address and shows the relay with no field to edit", async ({ page }) => {
  await saveRelayLink(page);
  await page.goto("/settings");
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "This device" }).click();
  await expect(
    page.getByText(DEV_BUILD ? "relay.custom.invalid" : "relay-doriface.omo.dev", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Direct address" })).toHaveCount(0);
  await expect(page.getByText("Direct address")).toHaveCount(0);
  await expect(page.getByText(DIRECT)).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: /relay/i })).toHaveCount(0);
});

test("adding a machine offers only the relay path", async ({ page }) => {
  await page.goto("/");
  const footer = page.getByRole("complementary", { name: "Workspace" }).locator('[data-slot="sidebar-footer"]');
  await footer.getByRole("button", { name: "Add machine" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a machine" });
  await expect(dialog).toContainText("through the relay");
  // It says it needs no ssh: what it must not offer is a direct or LAN path.
  await expect(dialog).not.toContainText(/direct|\bLAN\b|local network/i);
  await expect(dialog.getByRole("textbox")).toHaveCount(0);
});
