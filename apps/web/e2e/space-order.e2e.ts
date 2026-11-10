// Spaces reorder inside their machine, as herdr-app's `space.move` does: a drag, a row's menu or the move keys write the
// order to that machine's herdr-app document, so a second device shows it at once and a reload keeps it (#610).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "@playwright/test";
import { endAgent } from "./agents.ts";
import { E2E_HOST_PORT, E2E_TOKEN } from "./config.ts";
import { getCoreDoc, setCoreDoc } from "./core-doc.ts";
import { expect, test } from "./fixtures.ts";
import { shortcut } from "./platform-keys.ts";
import { LAYOUT_DOC, seedSpaces } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { MACHINE_NAME } from "./machine.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const REMOTE_SPACE = "Remote Only";
const nextTo = new Set(["Alpha", "Beta", "Gamma"]);

const started: string[] = [];
test.afterEach(() => {
  for (const address of started.splice(0)) endAgent("host", address);
});

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Workspace" });
const spaceRow = (page: Page, name: string) =>
  sidebar(page).getByRole("button", { name: new RegExp(`^${name}(?: |$)`) });

/** A second device: its own browser context (its own storage) on the same host. */
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

/** The ids of the core's saved spaces, in the document's order: the order every device reads. */
function savedIds(): readonly string[] {
  const doc = getCoreDoc(LAYOUT_DOC);
  if (typeof doc !== "object" || doc === null || !("spaces" in doc)) return [];
  const spaces = doc.spaces;
  if (!Array.isArray(spaces)) return [];
  return spaces.flatMap((space: unknown) =>
    typeof space === "object" && space !== null && "id" in space && typeof space.id === "string" ? [space.id] : [],
  );
}

/** The sidebar's rows, in the order they are drawn, as the three spaces of this spec's own machine name them. */
async function order(page: Page): Promise<readonly string[]> {
  const names = await sidebar(page)
    .getByRole("region", { name: "Spaces" })
    .getByRole("button")
    .evaluateAll((buttons) =>
      buttons.map((button) => button.querySelector("[data-floor='name']")?.getAttribute("title") ?? null),
    );
  return names.filter((name): name is string => name !== null && nextTo.has(name));
}

/** A shell of this spec's own, in `folder`, killed once the test ends. */
function startShellIn(name: string, folder: string): string {
  const out = hcOn("host", ["run", "--bg", "--name", name, "--cwd", folder, "--", "env", "PS1=$ ", "sh"]);
  const address = String((JSON.parse(out) as { address: string }).address);
  started.push(address);
  return address;
}

/** Three spaces of one machine, each with its own shell in its own folder, and no name another spec writes. */
function threeSpaces(): void {
  const root = mkdtempSync(join(tmpdir(), "space-order-"));
  const space = (name: string, id: string) => {
    const folder = mkdtempSync(join(root, `${name}-`));
    return {
      id,
      name,
      folder,
      tabs: [
        { id: `tb-${id}`, name: `${name} tab`, terminal: startShellIn(`space-order-${name.toLowerCase()}`, folder) },
      ],
    };
  };
  seedSpaces([space("Alpha", "spc-alpha"), space("Beta", "spc-beta"), space("Gamma", "spc-gamma")]);
}

/** How many spaces the added machine's own layout document holds. */
function remoteSpaceCount(): number {
  const doc = getCoreDoc(LAYOUT_DOC, MACHINE_NAME);
  return typeof doc === "object" && doc !== null && "spaces" in doc && Array.isArray(doc.spaces)
    ? doc.spaces.length
    : 0;
}

/** Presses `from`'s row and moves it until its centre passes `onto`'s, as a hand does; `release` lets go. */
async function drag(page: Page, from: string, onto: string, release = true): Promise<void> {
  const [source, target] = [await spaceRow(page, from).boundingBox(), await spaceRow(page, onto).boundingBox()];
  if (source === null || target === null) throw new Error(`no box for ${from} or ${onto}`);
  const x = source.x + source.width / 3;
  const y = source.y + source.height / 2;
  const by = target.y + target.height / 2 - y;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + Math.sign(by) * 6, { steps: 2 });
  await page.mouse.move(x, y + by + Math.sign(by) * 8, { steps: 8 });
  if (release) await page.mouse.up();
}

/** The chords that move a focused row up and down on the page's platform: the tab move keys (#123). */
async function moveKeys(page: Page): Promise<readonly [string, string]> {
  return [await shortcut(page, "tab.move:left"), await shortcut(page, "tab.move:right")];
}

test("a space dragged above another is written to its machine's layout, shown on a second device, and kept by a reload", async ({
  page,
  browser,
}) => {
  threeSpaces();
  const other = await secondDevice(browser);
  await Promise.all([page.goto("/"), other.goto("/")]);
  await expect(spaceRow(page, "Gamma")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => savedIds()).toEqual(["spc-alpha", "spc-beta", "spc-gamma"]);
  await expect.poll(() => order(page)).toEqual(["Alpha", "Beta", "Gamma"]);

  await drag(page, "Gamma", "Alpha");
  await expect.poll(() => savedIds(), { timeout: 15_000 }).toEqual(["spc-gamma", "spc-alpha", "spc-beta"]);
  await expect.poll(() => order(page)).toEqual(["Gamma", "Alpha", "Beta"]);
  await expect.poll(() => order(other), { timeout: 15_000 }).toEqual(["Gamma", "Alpha", "Beta"]);

  await page.reload();
  await expect(spaceRow(page, "Gamma")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => order(page)).toEqual(["Gamma", "Alpha", "Beta"]);
  await other.context().close();
});

test("the move keys move a focused space row, focus stays on it, and the move says where it went", async ({ page }) => {
  threeSpaces();
  await page.goto("/");
  await expect(spaceRow(page, "Gamma")).toBeVisible({ timeout: 20_000 });
  const [up] = await moveKeys(page);
  const row = spaceRow(page, "Gamma");
  await row.focus();
  await page.keyboard.press(up);
  await expect.poll(() => savedIds(), { timeout: 15_000 }).toEqual(["spc-alpha", "spc-gamma", "spc-beta"]);
  await expect(row).toBeFocused();
  await page.keyboard.press(up);
  await expect.poll(() => savedIds(), { timeout: 15_000 }).toEqual(["spc-gamma", "spc-alpha", "spc-beta"]);
  await expect(row).toBeFocused();
  await expect(
    sidebar(page).getByRole("region", { name: "Spaces" }).getByRole("status").filter({ hasText: "Moved Gamma" }),
  ).toHaveText("Moved Gamma to position 1 of 3");

  await page.reload();
  await expect(spaceRow(page, "Gamma")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => order(page)).toEqual(["Gamma", "Alpha", "Beta"]);
});

test("the row's menu moves a space up and down and offers no move past either end", async ({ page }) => {
  threeSpaces();
  await page.goto("/");
  await expect(spaceRow(page, "Gamma")).toBeVisible({ timeout: 20_000 });
  await spaceRow(page, "Gamma").hover();
  await sidebar(page).getByRole("button", { name: "More for Gamma" }).click();
  await expect(page.getByRole("menuitem", { name: "Move down" })).toHaveAttribute("aria-disabled", "true");
  await page.getByRole("menuitem", { name: "Move up" }).click();
  await expect.poll(() => savedIds(), { timeout: 15_000 }).toEqual(["spc-alpha", "spc-gamma", "spc-beta"]);

  await spaceRow(page, "Alpha").hover();
  await sidebar(page).getByRole("button", { name: "More for Alpha" }).click();
  await expect(page.getByRole("menuitem", { name: "Move up" })).toHaveAttribute("aria-disabled", "true");
  await page.getByRole("menuitem", { name: "Move down" }).click();
  await expect.poll(() => savedIds(), { timeout: 15_000 }).toEqual(["spc-gamma", "spc-alpha", "spc-beta"]);
});

test("a space dragged onto another machine's rows keeps both machines' orders as they were", async ({ page }) => {
  threeSpaces();
  seedSpaces([{ id: "spc-remote", name: REMOTE_SPACE, folder: "/srv/remote", tabs: [] }], MACHINE_NAME);
  try {
    await page.goto("/");
    await expect(spaceRow(page, REMOTE_SPACE)).toBeVisible({ timeout: 30_000 });
    expect(remoteSpaceCount()).toBe(1);

    // Alpha first here, so a drop that was taken would land it last: only the refusal keeps the order.
    await drag(page, "Alpha", REMOTE_SPACE);
    await page.reload();
    await expect(spaceRow(page, "Alpha")).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => order(page)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(savedIds()).toEqual(["spc-alpha", "spc-beta", "spc-gamma"]);
    expect(remoteSpaceCount()).toBe(1);
  } finally {
    setCoreDoc(LAYOUT_DOC, null, MACHINE_NAME);
  }
});
