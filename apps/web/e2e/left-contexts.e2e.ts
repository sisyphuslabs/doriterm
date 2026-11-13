// A context a test opened and did not close must not outlive it: its page stays connected to the worker's core and
// edits the shared layout as another device would (#2383, #2412). See ownPages in fixtures.ts.
import { E2E_HOST_PORT, E2E_TOKEN } from "./config.ts";
import { expect, test } from "./fixtures.ts";

// The two run in order on one worker: the second checks what the first left.
test.describe.configure({ mode: "serial" });

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

test("a test that opens a second device and leaves it open", async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const settings = {
    mode: "loopback",
    relayUrl: "wss://relay-doriface.omo.dev",
    directUrl: "",
    hostId: "",
    loopbackUrl: `ws://127.0.0.1:${E2E_HOST_PORT}/v1/hc`,
    token: E2E_TOKEN,
  };
  await context.addInitScript((value) => localStorage.setItem("doriface.connection", value), JSON.stringify(settings));
  const other = await context.newPage();
  await other.goto("/");
  await expect(other.getByRole("contentinfo")).toContainText("terminal", { timeout: 20_000 });
});

test("the next test starts with no page an earlier test left", async ({ page, browser }) => {
  await page.goto("about:blank");
  expect(browser.contexts()).toEqual([page.context()]);
});
