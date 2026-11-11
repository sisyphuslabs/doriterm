// Two devices on one layout (#2146): an ended pane goes everywhere once any device has it out of view, and the device
// that was showing it as ended says so; a split whose terminal another device adopted while its write waited leaves
// the view on the tab that shows that terminal.
import { writeFileSync } from "node:fs";
import type { Browser, Page } from "@playwright/test";
import { E2E_HOST_PORT, E2E_TOKEN } from "./config.ts";
import { getCoreDoc } from "./core-doc.ts";
import { removeTerminal, stateOn, waitFor } from "./ended-terminal.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { LAYOUT_DOC } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { pressShortcut } from "./platform-keys.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

/** A second device: its own browser context, so its own storage and its own reading of the same core. */
async function secondDevice(browser: Browser): Promise<Page> {
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
  return context.newPage();
}

/** The terminals the saved layout's panes show, in document order. */
const savedTerminals = (): string[] =>
  [...JSON.stringify(getCoreDoc(LAYOUT_DOC) ?? null).matchAll(/"terminal":"([^"]+)"/g)].map((match) => match[1] ?? "");

const tabsOf = (page: Page) => page.getByRole("tablist", { name: "Tabs" }).getByRole("tab");

const focusedAddress = (page: Page): Promise<string | null> =>
  page.locator('[data-focused="true"] [data-terminal]').getAttribute("data-terminal", { timeout: 15_000 });

test("an ended tab one device shows as ended goes when another device, which has it out of view, drops it, and the first says why", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const go = test.info().outputPath("go");
  await page.goto("/");
  const ending = await openNewTerminal(page);
  const address = (await ending.getAttribute("data-terminal")) ?? "";
  const other = await secondDevice(browser);
  try {
    hcOn("host", ["send", address, waitFor(go)]);
    await expect(ending).toContainText("armed-9", { timeout: 15_000 });
    await openNewTerminal(page);
    await expect.poll(savedTerminals, { timeout: 15_000 }).toHaveLength(2);
    // This device leaves with the ending terminal's tab in view, so it comes back to that tab.
    await tabsOf(page).first().click();
    await expect(page.locator(`[data-focused="true"] [data-terminal="${address}"]`)).toHaveCount(1);
    await page.goto("about:blank");

    // The other device looks at the second tab; the first is out of view there, and its drop is held on the way.
    const link = await routeHcSocket(other);
    await other.goto("/");
    await expect(tabsOf(other)).toHaveCount(2, { timeout: 20_000 });
    await tabsOf(other).nth(1).click();
    const release = link.hold("doc.set");
    writeFileSync(go, "");
    await expect.poll(() => stateOn("host", address), { timeout: 15_000 }).toBe("finished");

    // Back on the first device, the tab in view is the one whose program ended while no view of it was attached.
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "This session ended" })).toBeVisible({ timeout: 20_000 });
    await expect(tabsOf(page)).toHaveCount(2);

    // The other device's drop lands: the pane goes from the shared layout and from this device's strip, which says why.
    release();
    await expect.poll(savedTerminals, { timeout: 15_000 }).not.toContain(address);
    await expect(tabsOf(page)).toHaveCount(1, { timeout: 15_000 });
    await expect(page.getByText("Another device closed its tab once its program had finished.")).toBeVisible();
  } finally {
    await other.context().close();
    removeTerminal("host", address, go);
  }
});

test("a split whose terminal another device adopted while its write waited leaves the view on the tab that shows it", async ({
  page,
  browser,
}) => {
  const link = await routeHcSocket(page);
  await page.goto("/");
  const first = await openNewTerminal(page);
  const from = (await first.getAttribute("data-terminal")) ?? "";
  await expect.poll(savedTerminals, { timeout: 15_000 }).toEqual([from]);
  const other = await secondDevice(browser);
  try {
    await other.goto("/");
    await expect(tabsOf(other)).toHaveCount(1, { timeout: 20_000 });

    // The split starts its terminal; the write that puts it beside the pane it came from is held on its way.
    const release = link.hold("doc.set");
    await first.getByRole("textbox").focus();
    await pressShortcut(page, "pane.split:right");
    // The other device sees a live terminal in no tab, and adopts it as a tab of its own once its grace is over.
    await expect.poll(savedTerminals, { timeout: 20_000 }).toHaveLength(2);
    const adopted = savedTerminals().find((terminal) => terminal !== from) ?? "";

    // The held write finds the terminal shown and writes nothing; the view goes to the tab that shows it.
    release();
    await expect.poll(() => focusedAddress(page), { timeout: 15_000 }).toBe(adopted);
    expect(savedTerminals().toSorted()).toEqual([from, adopted].toSorted());
  } finally {
    await other.context().close();
  }
});
