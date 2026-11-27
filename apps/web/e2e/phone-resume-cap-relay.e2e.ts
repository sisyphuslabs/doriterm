import { expect, test } from "@playwright/test";
import { PHONE } from "./phone-key-bar.ts";
import { PRIVATE_RELAY_SKIP } from "./private-relay.ts";
import { pairAndOpenTerminal, RelayLink, type RelayHost, startRelayHost } from "./relay-terminal.ts";

test.skip(process.env["DORIFACE_RELAY_DIR"] === undefined, PRIVATE_RELAY_SKIP);
// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block", ...PHONE });
// A relay, host and core of its own (up to 180 s to start), pairing over the relay, then an outage and its end.
test.setTimeout(300_000);

let host: RelayHost | undefined;
test.beforeEach(async () => {
  host = await startRelayHost();
});
test.afterEach(async () => {
  await host?.stop();
  host = undefined;
});

/** Past the host's 5 s grace, so the reason is up before the link comes back. */
const OUTAGE_MS = 5_500;

/**
 * A phone whose relay link was gone for 5.5 s finds it within 3 s of its return (#2928): the session resume never waits
 * longer than 3 s between dials, so "Can't connect", up since the grace ended, clears with the resumed session. On the
 * old ladder the next dial was 9 s in, 3.5 s after the return.
 */
test("at 390 the reason shown during an outage clears within 3 s of the link's return", async ({ page }) => {
  const link = new RelayLink();
  const relayed = host;
  if (relayed === undefined) throw new Error("no relayed host");
  const terminal = await pairAndOpenTerminal(page, relayed, { phone: true, link });

  link.refuse(true);
  const droppedAt = Date.now();
  await link.drop();
  const reason = page.locator("header [data-host-down]");
  await expect(reason).toBeVisible({ timeout: 15_000 });
  // The outage's length is the behavior under test.
  await page.waitForTimeout(Math.max(0, droppedAt + OUTAGE_MS - Date.now()));
  link.refuse(false);

  await expect(reason).toHaveCount(0, { timeout: 3_000 });
  await expect(page.locator("header [data-terminal-line]:not([data-terminal-line=history-gap])")).toHaveCount(0);
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type("echo back-in-time-$((1+1))");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("back-in-time-2", { timeout: 20_000 });
});
