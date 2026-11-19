// A space and an agent are renamed straight from their list rows, without opening them first (#2658): on a desktop by
// a double-click or the row's menu from the keyboard, on a phone at 390 px by the row's own "...".
import { devices, type Locator, type Page } from "@playwright/test";
import { agentRow, endAgent, startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { hcOn } from "./machine-switch.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const started: string[] = [];
test.afterEach(() => {
  for (const address of started.splice(0)) endAgent("host", address);
});

/** An idle agent in a space of its own, both named after the test's repeat so a rerun never meets an earlier one. */
function seed(tag: string): { readonly agent: string; readonly space: string; readonly address: string } {
  const repeat = test.info().repeatEachIndex;
  const agent = `rl-${tag}-${repeat}`;
  const space = `rlsp-${tag}-${repeat}`;
  const address = startAgent("host", agent, "idle", space);
  started.push(address);
  return { agent, space, address };
}

/** A label of the terminal as hc holds it: what every client reads. */
function labelInHc(address: string, label: string): unknown {
  const got: unknown = JSON.parse(hcOn("host", ["get", address, "--json"]));
  const labels = typeof got === "object" && got !== null ? Reflect.get(got, "labels") : undefined;
  return typeof labels === "object" && labels !== null ? Reflect.get(labels, label) : undefined;
}

const param = (page: Page, name: string): string | null => new URL(page.url()).searchParams.get(name);

/** Types the new name into the open Rename question and confirms it. */
async function answer(page: Page, title: RegExp | string, name: string): Promise<void> {
  const dialog = page.getByRole("dialog", { name: title });
  const field = dialog.getByRole("textbox");
  await expect(field).toBeFocused();
  await field.fill(name);
  await field.press("Enter");
  await expect(dialog).toBeHidden();
}

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Workspace" });
const agents = (page: Page): Locator => sidebar(page).getByRole("region", { name: "Agents", exact: true });
const spaceRow = (page: Page, name: string) =>
  sidebar(page).getByRole("button", { name: new RegExp(`^${name}(?: |$)`) });

test.describe("desktop", () => {
  test("double-clicking an agent row asks for its new name, and hc holds it", async ({ page }) => {
    const { agent, address } = seed("dbl");
    await page.goto("/");
    const row = agentRow(agents(page), agent, false);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.dblclick();
    await answer(page, /^Rename /, `${agent}-new`);
    await expect(agentRow(agents(page), `${agent}-new`, false)).toBeVisible();
    await expect.poll(() => labelInHc(address, "herdr.name")).toBe(`${agent}-new`);
  });

  test("a focused space row renames from the keyboard alone: Shift+F10, Rename space…, a name, Enter", async ({
    page,
  }) => {
    const { space, address } = seed("key");
    await page.goto("/");
    const row = spaceRow(page, space);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.focus();
    await page.keyboard.press("Shift+F10");
    const item = page.getByRole("menu").getByRole("menuitem", { name: "Rename space…" });
    await expect(item).toBeVisible();
    await item.focus();
    await page.keyboard.press("Enter");
    await answer(page, `Rename ${space}`, `${space}-new`);
    await expect(spaceRow(page, `${space}-new`)).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => labelInHc(address, "space")).toBe(`${space}-new`);
  });
});

const { defaultBrowserType: _engine, ...iphone } = devices["iPhone 14"];

test.describe("phone at 390x844", () => {
  test.use({ ...iphone, viewport: { width: 390, height: 844 } });

  test("a space row's own More renames the space from the Spaces list, which stays in view", async ({ page }) => {
    const { space, address } = seed("psp");
    await page.goto("/?v=spaces");
    const more = page.getByRole("button", { name: `More for ${space}` });
    await expect(more).toBeVisible({ timeout: 20_000 });
    await more.click();
    await page.getByRole("menuitem", { name: "Rename space…" }).click();
    await answer(page, `Rename ${space}`, `${space}-new`);
    await expect(page.getByRole("button", { name: new RegExp(`^${space}-new\\b`) })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { level: 1, name: "Spaces", exact: true })).toBeVisible();
    expect(param(page, "s"), "the space was not opened").toBeNull();
    await expect.poll(() => labelInHc(address, "space")).toBe(`${space}-new`);
  });

  test("an agent row's own More renames the agent from the Agents list, which stays in view", async ({ page }) => {
    const { agent, address } = seed("pag");
    await page.goto("/");
    const more = page.getByRole("button", { name: `More for ${agent}` });
    await expect(more).toBeVisible({ timeout: 20_000 });
    await more.click();
    await page.getByRole("menuitem", { name: "Rename…" }).click();
    await answer(page, /^Rename /, `${agent}-new`);
    await expect(page.getByRole("button", { name: `More for ${agent}-new` })).toBeVisible();
    expect(param(page, "t"), "the agent was not opened").toBeNull();
    await expect.poll(() => labelInHc(address, "herdr.name")).toBe(`${agent}-new`);
  });
});
