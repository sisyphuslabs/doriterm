// Tabs belong to a space, as in herdr-app (#404): the tab bar shows the selected space's tabs, a space remembers the tab
// it showed, "+" and a split stay in the space and tab they were made in, and a live terminal in no tab is adopted into
// the space whose folder holds it, else into its machine's Home space.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { basename } from "node:path";
import type { Page } from "@playwright/test";
import { getCoreDoc } from "./core-doc.ts";
import { expect, test, pressNewTab } from "./fixtures.ts";
import { LAYOUT_DOC, seedSpaces } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";

test.use({ serviceWorkers: "block" });

const started: string[] = [];
test.afterEach(() => {
  for (const address of started.splice(0)) {
    try {
      hcOn("host", ["kill", address]);
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('"kind":"not_found"'))) throw error;
    }
  }
});

/** A plain shell started straight on the core in `cwd`, in no tab. */
function shellIn(cwd: string, name: string): string {
  const out = hcOn("host", ["run", "--bg", "--name", name, "--cwd", cwd, "--", "env", "PS1=$ ", "sh"]);
  const address = String((JSON.parse(out) as { address: string }).address);
  started.push(address);
  return address;
}

/** Each saved space's name and its tabs' names, in the document's order. */
function savedSpaces(): readonly (readonly [string, readonly string[]])[] {
  const doc = getCoreDoc(LAYOUT_DOC) as { spaces?: { name?: string; tabs?: { name?: string }[] }[] } | null;
  return (doc?.spaces ?? []).map((space) => [space.name ?? "", (space.tabs ?? []).map((tab) => tab.name ?? "")]);
}

/** How many panes the saved tab `id` holds. */
function panesIn(id: string): number {
  const doc = getCoreDoc(LAYOUT_DOC) as { spaces?: { tabs?: { id?: string; root?: unknown }[] }[] } | null;
  const tab = (doc?.spaces ?? []).flatMap((space) => space.tabs ?? []).find((each) => each.id === id);
  const count = (node: unknown): number => {
    if (typeof node !== "object" || node === null) return 0;
    const children = (node as { children?: unknown[] }).children;
    return Array.isArray(children) ? children.reduce<number>((sum, child) => sum + count(child), 0) : 1;
  };
  return count(tab?.root);
}

const tabBar = (page: Page) => page.getByRole("tablist", { name: "Tabs" }).getByRole("tab");
const spaceRow = (page: Page, name: string) =>
  page
    .getByRole("complementary", { name: "Workspace" })
    .getByRole("region", { name: "Spaces" })
    .getByRole("button", { name: new RegExp(`^${name}\\b`) });

/** Two spaces of two tabs each, every tab one shell started in its space's folder. */
function twoSpaces(): { readonly alpha: string; readonly beta: string } {
  const root = mkdtempSync(join(tmpdir(), "tabs-per-space-"));
  const alpha = mkdtempSync(join(root, "alpha-"));
  const beta = mkdtempSync(join(root, "beta-"));
  seedSpaces([
    {
      id: "spc-alpha",
      name: "alpha",
      folder: alpha,
      tabs: [
        { id: "tb-a1", name: "a-one", terminal: shellIn(alpha, "space-a1") },
        { id: "tb-a2", name: "a-two", terminal: shellIn(alpha, "space-a2") },
      ],
    },
    {
      id: "spc-beta",
      name: "beta",
      folder: beta,
      tabs: [
        { id: "tb-b1", name: "b-one", terminal: shellIn(beta, "space-b1") },
        { id: "tb-b2", name: "b-two", terminal: shellIn(beta, "space-b2") },
      ],
    },
  ]);
  return { alpha, beta };
}

test("the tab bar shows the selected space's tabs, and each space comes back on the tab it showed", async ({
  page,
}) => {
  twoSpaces();
  await page.goto("/");
  await spaceRow(page, "alpha").click();
  await expect(tabBar(page)).toHaveText([/a-one/, /a-two/]);
  await tabBar(page).filter({ hasText: "a-two" }).click();
  await expect(page.getByRole("tab", { selected: true })).toHaveText(/a-two/);

  await spaceRow(page, "beta").click();
  await expect(tabBar(page)).toHaveText([/b-one/, /b-two/]);
  await expect(page.getByRole("tab", { selected: true })).toHaveText(/b-one/);

  await spaceRow(page, "alpha").click();
  await expect(tabBar(page)).toHaveText([/a-one/, /a-two/]);
  await expect(page.getByRole("tab", { selected: true })).toHaveText(/a-two/);
});

test('"+" adds a tab right after the selected one, in the selected space only, and a split stays inside its tab', async ({
  page,
}) => {
  twoSpaces();
  await page.goto("/");
  await spaceRow(page, "beta").click();
  await expect(tabBar(page)).toHaveCount(2);
  await pressNewTab(page.getByRole("button", { name: "New tab" }));
  await expect(tabBar(page)).toHaveCount(3, { timeout: 15_000 });
  await expect.poll(savedSpaces, { timeout: 15_000 }).toEqual([
    ["alpha", ["a-one", "a-two"]],
    ["beta", ["b-one", "", "b-two"]],
  ]);

  await spaceRow(page, "alpha").click();
  await expect(tabBar(page)).toHaveText([/a-one/, /a-two/]);
  await tabBar(page).filter({ hasText: "a-one" }).click();
  await page.getByRole("button", { name: "Split right" }).click();
  await expect.poll(() => panesIn("tb-a1"), { timeout: 15_000 }).toBe(2);
  await expect(tabBar(page)).toHaveText([/a-one/, /a-two/]);
  await expect.poll(savedSpaces, { timeout: 15_000 }).toEqual([
    ["alpha", ["a-one", "a-two"]],
    ["beta", ["b-one", "", "b-two"]],
  ]);
});

test("a live terminal in no tab is adopted into the space whose folder holds it, else into a space named after its work, once (#2670)", async ({
  page,
}) => {
  const { beta } = twoSpaces();
  const inBeta = shellIn(beta, "loose-in-beta");
  const workdir = mkdtempSync(join(tmpdir(), "loose-work-"));
  const elsewhere = shellIn(workdir, "loose-elsewhere");
  const workName = basename(workdir);
  await page.goto("/");

  await spaceRow(page, "beta").click();
  await expect(tabBar(page)).toHaveCount(3, { timeout: 15_000 });
  await expect(page.locator(`[data-terminal="${inBeta}"]`)).toBeHidden();
  await tabBar(page).last().click();
  await expect(page.locator(`[data-terminal="${inBeta}"]`)).toBeVisible({ timeout: 15_000 });

  await spaceRow(page, workName).click();
  await expect(tabBar(page)).toHaveCount(1);
  await expect(page.locator(`[data-terminal="${elsewhere}"]`)).toBeVisible({ timeout: 15_000 });

  const adopted = savedSpaces();
  expect(adopted.map(([name, tabs]) => [name, tabs.length])).toEqual([
    ["alpha", 2],
    ["beta", 3],
    ["", 1],
  ]);
  await page.reload();
  await expect(spaceRow(page, workName)).toBeVisible({ timeout: 20_000 });
  expect(savedSpaces()).toEqual(adopted);
});
