// A closed space's colour leaves the device's sidebar prefs; another space's stays (#2583, #2585 review).
import type { Page } from "@playwright/test";
import { endAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { hcOn } from "./machine-switch.ts";

test.use({ serviceWorkers: "block" });

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Workspace" });
const spaceRow = (page: Page, name: string) =>
  sidebar(page).getByRole("button", { name: new RegExp(`^${name}(?: |$)`) });

const started: string[] = [];

function startIn(space: string, name: string): void {
  const out = hcOn("host", ["run", "--bg", "--name", name, "--label", `space=${space}`, "--", "env", "PS1=$ ", "sh"]);
  const parsed: unknown = JSON.parse(out);
  if (typeof parsed !== "object" || parsed === null || !("address" in parsed)) throw new Error(out);
  started.push(String(parsed.address));
}

/** The colour keys the device keeps (`space:<machine id>/<space id>`). */
async function colourKeys(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => {
    const raw: unknown = JSON.parse(localStorage.getItem("doriface.sidebar") ?? "{}");
    const colors = typeof raw === "object" && raw !== null ? Reflect.get(raw, "colors") : undefined;
    return typeof colors === "object" && colors !== null ? Object.keys(colors) : [];
  });
}

test.afterEach(() => {
  for (const address of started.splice(0)) {
    try {
      endAgent("host", address);
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('"kind":"not_found"'))) throw error;
    }
  }
});

test("closing a space drops its saved colour and keeps the other space's (#2583)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const gone = `prune-gone-${test.info().repeatEachIndex}`;
  const kept = `prune-kept-${test.info().repeatEachIndex}`;
  startIn(gone, "pr-one");
  startIn(kept, "pr-two");
  await page.goto("/");
  await expect(spaceRow(page, gone)).toBeVisible({ timeout: 20_000 });
  await expect(spaceRow(page, kept)).toBeVisible({ timeout: 20_000 });
  // Both spaces are coloured, and the colours are saved.
  await expect.poll(async () => (await colourKeys(page)).length).toBeGreaterThanOrEqual(2);
  const before = await colourKeys(page);

  await spaceRow(page, gone).hover();
  await sidebar(page)
    .getByRole("button", { name: `More for ${gone}` })
    .click();
  await page.getByRole("menuitem", { name: "Close space\u2026" }).click();
  await page.getByRole("dialog", { name: "Close space?" }).getByRole("button", { name: "Close" }).click();
  await expect(spaceRow(page, gone)).toHaveCount(0, { timeout: 20_000 });

  // Exactly the closed space's colour is gone; every other one, the kept space's included, is still saved.
  await expect.poll(async () => (await colourKeys(page)).length).toBe(before.length - 1);
  const after = await colourKeys(page);
  expect(after.every((key) => before.includes(key))).toBe(true);
  await expect(spaceRow(page, kept)).toBeVisible();
});
