import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { seedSpaces } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { endOwnTerminals } from "./own-terminals.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

endOwnTerminals();

const dialog = (page: Page) => page.getByRole("dialog", { name: "Command palette" });
const where = (page: Page) => dialog(page).locator('[data-slot="palette-where"]');

function startShellIn(space: string, name: string): string {
  const out = hcOn("host", ["run", "--bg", "--name", name, "--label", `space=${space}`, "--", "env", "PS1=$ ", "sh"]);
  const started: unknown = JSON.parse(out);
  if (typeof started !== "object" || started === null || !("address" in started)) throw new Error(out);
  return String(started.address);
}

test("the palette says where the highlighted agent lives, and nothing for an action (#1465)", async ({ page }) => {
  const run = Date.now().toString(36);
  const twin = `twin-${run}`;
  const one = startShellIn(`whr-a-${run}`, `${twin}-a`);
  const two = startShellIn(`whr-b-${run}`, `${twin}-b`);
  seedSpaces([
    { id: "spc-whr-a", name: `whr-a-${run}`, folder: "", tabs: [{ id: "tb-whr-a", name: "", terminal: one }] },
    { id: "spc-whr-b", name: `whr-b-${run}`, folder: "", tabs: [{ id: "tb-whr-b", name: "", terminal: two }] },
  ]);
  await page.goto("/");
  await expect(page.getByRole("tablist", { name: "Tabs" })).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press("ControlOrMeta+Shift+KeyP");
  await page.getByRole("combobox", { name: "Command" }).fill(twin);
  await expect(dialog(page).getByRole("option")).toHaveCount(2);

  await expect(where(page)).toContainText(/whr-[ab]-/);
  const first = (await where(page).textContent()) ?? "";
  await page.keyboard.press("ArrowDown");
  await expect(where(page)).not.toHaveText(first);
  await expect(where(page)).toContainText(first.includes(`whr-a-${run}`) ? `whr-b-${run}` : `whr-a-${run}`);
  await expect(dialog(page).getByRole("option", { selected: true })).toHaveAccessibleDescription(/whr-[ab]-/);

  await page.getByRole("combobox", { name: "Command" }).fill("Split right");
  await expect(dialog(page).getByRole("option", { selected: true })).toContainText("Split right");
  await expect(where(page)).toHaveCount(0);
});
