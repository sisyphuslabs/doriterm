import type { Browser, Locator, Page } from "@playwright/test";
import { E2E_HOST_PORT, E2E_TOKEN } from "./config.ts";
import { expect, test } from "./fixtures.ts";
import { seedSpaces } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { rows } from "./sidebar-measure.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

endOwnTerminals();

const SPACE = "att611";

const strip = (page: Page) => page.getByRole("tablist", { name: "Tabs" });
/** The strip's tab showing `title`: its glyph is drawn beside the name, not part of what the tab is called. */
const tabOf = (page: Page, title: string) => strip(page).getByRole("tab").filter({ hasText: title });
/** The glyph a tab or an agent row draws for a status: herdr-app's dot (done), spinner (working), ring (idle). */
const glyph = (scope: Page | Locator, status: string) => scope.getByRole("img", { name: status, exact: true });
const sidebar = (page: Page) => page.getByRole("complementary", { name: "Workspace" });
const section = (page: Page, title: string) => sidebar(page).getByRole("region", { name: title, exact: true });
/** An agent's row in one of the sidebar's status sections, when it is in that section at all. */
const rowOf = (page: Page, title: string, name: string) => rows(section(page, title)).filter({ hasText: name });

/** A shell in this test's space: it reports a status only when told to, as an agent does when its turn changes. */
function startShell(name: string): string {
  const out = hcOn("host", ["run", "--bg", "--name", name, "--label", `space=${SPACE}`, "--", "env", "PS1=$ ", "sh"]);
  const started: unknown = JSON.parse(out);
  if (typeof started !== "object" || started === null || !("address" in started)) throw new Error(out);
  return String(started.address);
}

/** Types into the shell a report of `state` over OSC 7501, as an agent sends when its turn changes. */
function report(address: string, state: string): void {
  // hc refuses to type into a blocked terminal unless forced: the report that ends the block has to be.
  hcOn("host", ["send", "--force", address, `printf '\\033]7501;state=${state}\\033\\\\'`]);
}

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

test("an agent that finished where this screen was not looking is Done until shown, then Idle here alone", async ({
  page,
  browser,
}) => {
  const quiet = startShell("att-quiet");
  const flip = startShell("att-flip");
  seedSpaces([
    {
      folder: "",
      id: "spc-att611",
      name: SPACE,
      tabs: [
        { id: "tb-att-quiet", name: "quiet", terminal: quiet },
        { id: "tb-att-flip", name: "flip", terminal: flip },
      ],
    },
  ]);
  await page.goto("/");
  await expect(strip(page).getByRole("tab")).toHaveCount(2, { timeout: 20_000 });
  await expect(tabOf(page, "quiet")).toHaveAttribute("aria-selected", "true");

  // The agent finishes while its tab is not the one on screen: herdr-app's dot, and its row waits under Done.
  report(flip, "done");
  await expect(glyph(tabOf(page, "flip"), "Done")).toBeVisible({ timeout: 15_000 });
  await expect(rowOf(page, "Done", "att-flip")).toBeVisible({ timeout: 15_000 });

  // Another device has not looked either, so it still says Done.
  const other = await secondDevice(browser);
  await other.goto("/");
  await expect(strip(other).getByRole("tab")).toHaveCount(2, { timeout: 20_000 });
  await expect(glyph(tabOf(other, "flip"), "Done")).toBeVisible();
  await expect(rowOf(other, "Done", "att-flip")).toBeVisible();

  // This screen shows the tab: the dot clears here and the row moves to Idle, with nothing left to attend to.
  await tabOf(page, "flip").click();
  await expect(tabOf(page, "flip")).toHaveAttribute("aria-selected", "true");
  await expect(glyph(tabOf(page, "flip"), "Done")).toHaveCount(0);
  await expect(tabOf(page, "flip").getByRole("img")).toHaveCount(0);
  await expect(rowOf(page, "Idle", "att-flip")).toBeVisible();
  await expect(rowOf(page, "Done", "att-flip")).toHaveCount(0);

  // It is this screen's memory only: the device that never showed it still says Done.
  await expect(glyph(tabOf(other, "flip"), "Done")).toBeVisible();
  await expect(rowOf(other, "Done", "att-flip")).toBeVisible();

  // And it is kept: a reload of this screen still reads Idle, not Done.
  await page.reload();
  await expect(tabOf(page, "flip")).toHaveAttribute("aria-selected", "true", { timeout: 20_000 });
  await expect(glyph(tabOf(page, "flip"), "Done")).toHaveCount(0);
  await expect(rowOf(page, "Idle", "att-flip")).toBeVisible();

  // A later finish asks again: hc reports it with a new status_ms, and this screen is not showing that tab.
  await tabOf(page, "quiet").click();
  await expect(tabOf(page, "flip")).toHaveAttribute("aria-selected", "false");
  report(flip, "working");
  await expect(glyph(tabOf(page, "flip"), "Working")).toBeVisible({ timeout: 15_000 });
  report(flip, "done");
  await expect(glyph(tabOf(page, "flip"), "Done")).toBeVisible({ timeout: 15_000 });
  await expect(rowOf(page, "Done", "att-flip")).toBeVisible();

  await other.context().close();
});

test("the status bar's needs-you count opens each terminal that needs you in turn, and is words again once none does", async ({
  page,
}) => {
  const calm = startShell("att-calm");
  const askA = startShell("att-ask-a");
  const askB = startShell("att-ask-b");
  seedSpaces([
    {
      folder: "",
      id: "spc-att1448",
      name: SPACE,
      tabs: [
        { id: "tb-att-calm", name: "calm", terminal: calm },
        { id: "tb-att-ask-a", name: "ask-a", terminal: askA },
        { id: "tb-att-ask-b", name: "ask-b", terminal: askB },
      ],
    },
  ]);
  await page.goto("/");
  await expect(tabOf(page, "calm")).toHaveAttribute("aria-selected", "true", { timeout: 20_000 });
  const needsYou = page.getByRole("contentinfo").getByRole("button", { name: /needs you$/ });
  await expect(needsYou).toHaveCount(0);

  report(askA, "blocked");
  report(askB, "blocked");
  await expect(needsYou).toHaveText("2 needs you", { timeout: 15_000 });

  const titles = ["calm", "ask-a", "ask-b"] as const;
  const selected = async (): Promise<string> => {
    const states = await Promise.all(titles.map((title) => tabOf(page, title).getAttribute("aria-selected")));
    return titles[states.indexOf("true")] ?? "none";
  };
  await needsYou.click();
  await expect.poll(selected).toMatch(/^ask-[ab]$/);
  const first = await selected();
  await needsYou.click();
  await expect.poll(selected).toBe(first === "ask-a" ? "ask-b" : "ask-a");
  await needsYou.click();
  await expect.poll(selected).toBe(first);

  report(askA, "working");
  report(askB, "working");
  await expect(needsYou).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByRole("contentinfo")).toContainText("terminals");
});

test("an agent that finishes in the tab on screen asks for nobody: its row goes straight to Idle", async ({ page }) => {
  const live = startShell("att-live");
  seedSpaces([
    {
      folder: "",
      id: "spc-att611-one",
      name: SPACE,
      tabs: [{ id: "tb-att-live", name: "live", terminal: live }],
    },
  ]);
  await page.goto("/");
  await expect(tabOf(page, "live")).toHaveAttribute("aria-selected", "true", { timeout: 20_000 });
  report(live, "working");
  await expect(glyph(tabOf(page, "live"), "Working")).toBeVisible({ timeout: 15_000 });
  await expect(rowOf(page, "Working", "att-live")).toBeVisible();

  report(live, "done");
  await expect(rowOf(page, "Idle", "att-live")).toBeVisible({ timeout: 15_000 });
  await expect(rowOf(page, "Done", "att-live")).toHaveCount(0);
  await expect(glyph(tabOf(page, "live"), "Done")).toHaveCount(0);
});
