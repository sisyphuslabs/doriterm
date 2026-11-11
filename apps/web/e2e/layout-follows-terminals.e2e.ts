// The layout follows the terminals while the page is open, as herdr-app's reconcile keeps its own (#2122): a terminal
// started outside the app gets a tab a few seconds after it starts, and a tab out of view goes once its terminal has
// exited or was killed. Neither waits for a reload.
import type { Page } from "@playwright/test";
import { endAgent, startShell } from "./agents.ts";
import { getCoreDoc } from "./core-doc.ts";
import { stateOn } from "./ended-terminal.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { LAYOUT_DOC } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { pressShortcut } from "./platform-keys.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const started: string[] = [];
test.afterEach(() => {
  for (const address of started.splice(0)) if (stateOn("host", address) === "live") endAgent("host", address);
});

/** A shell started straight on the e2e core, as `hc run` or an agent starts one: no page asked for it. */
function startOutside(name: string): string {
  const address = startShell("host", name);
  started.push(address);
  return address;
}

/** How many panes of the saved layout show the terminal: one once it has its tab, never two. */
const panesShowing = (address: string): number =>
  JSON.stringify(getCoreDoc(LAYOUT_DOC) ?? null).split(`"terminal":"${address}"`).length - 1;

/** The count on the sidebar row of the space startShell's label names. */
const apiCount = (page: Page) =>
  page
    .getByRole("complementary", { name: "Workspace" })
    .getByRole("region", { name: "Spaces" })
    .getByRole("button", { name: /^api\b/ })
    .getByLabel(/^\d+ tabs$/);

const addressOf = async (terminal: Awaited<ReturnType<typeof openNewTerminal>>): Promise<string> =>
  (await terminal.getAttribute("data-terminal")) ?? "";

test("a terminal started outside the app gets one tab and raises its space's count without a reload, and loses both when it ends in a tab nobody opened", async ({
  page,
}) => {
  await page.goto("/");
  await openNewTerminal(page);

  const first = startOutside("outside-first");
  await expect(apiCount(page)).toHaveText("1", { timeout: 20_000 });
  const second = startOutside("outside-second");
  await expect(apiCount(page)).toHaveText("2", { timeout: 20_000 });
  expect([first, second].map(panesShowing)).toEqual([1, 1]);

  // Its tab was never shown, so no view of it is attached to hear the end: the page asks the core about it instead.
  hcOn("host", ["kill", first]);
  await expect(apiCount(page)).toHaveText("1", { timeout: 20_000 });
  expect([first, second].map(panesShowing)).toEqual([0, 1]);
});

test("a tab closed on purpose does not come back while its End is still in flight", async ({ page }) => {
  const link = await routeHcSocket(page);
  await page.goto("/");
  await openNewTerminal(page);
  const terminal = await openNewTerminal(page);
  const address = await addressOf(terminal);
  const release = link.hold("terminal.kill");
  await terminal.getByRole("textbox").focus();
  await pressShortcut(page, "pane.close");
  await expect(page.locator(`[data-terminal="${address}"]`)).toHaveCount(0);

  // Its kill is held, so its program still runs, in no tab, with End's mark on it. A terminal started outside the app
  // now is adopted once its grace is over; the one being ended has been in no tab for longer, and is not.
  const outside = startOutside("after-the-close");
  await expect.poll(() => panesShowing(outside), { timeout: 20_000 }).toBe(1);
  expect(panesShowing(address)).toBe(0);
  expect(stateOn("host", address)).toBe("live");

  release();
  await expect.poll(() => stateOn("host", address), { timeout: 15_000 }).toBe("gone");
});

test("a tab another device's adoption saved while this device's own write waited is not saved a second time", async ({
  page,
}) => {
  const link = await routeHcSocket(page);
  await page.goto("/");
  await openNewTerminal(page);
  const other = await page.context().newPage();
  await other.goto("/");
  await expect(other.getByRole("tablist", { name: "Tabs" }).getByRole("tab")).toHaveCount(1, { timeout: 20_000 });

  // This device starts a terminal: its tab is on its own screen at once, and the write that saves it is held on its way.
  const release = link.hold("doc.set");
  const address = await addressOf(await openNewTerminal(page));
  // The other device sees a live terminal that the saved layout shows in no tab, and adopts it once its grace is over.
  await expect.poll(() => panesShowing(address), { timeout: 20_000 }).toBe(1);

  // The held write reaches the core, finds the layout changed, and is tried again on the layout the other device
  // saved. A later write of this device's goes out only once that one has settled: a third terminal's tab.
  release();
  const third = await addressOf(await openNewTerminal(page));
  await expect.poll(() => panesShowing(third), { timeout: 15_000 }).toBe(1);
  expect(panesShowing(address)).toBe(1);
  await expect(page.locator(`[data-terminal="${address}"]`)).toHaveCount(1);
  await other.close();
});
