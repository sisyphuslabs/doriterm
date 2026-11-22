// #2658: a space with no saved name or folder whose terminal starts in the root or a system directory (on Windows,
// C:\Windows\System32 when the shell is started by a service) is named after its shell, never after that path.
import type { Page } from "@playwright/test";
import { endAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { seedSpaces } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { rows } from "./sidebar-measure.ts";

test.use({ serviceWorkers: "block" });

const started: string[] = [];

function startIn(cwd: string, name: string): string {
  const out = hcOn("host", ["run", "--bg", "--name", name, "--cwd", cwd, "--", "bash", "-c", "exec sleep 600"]);
  const parsed: unknown = JSON.parse(out);
  if (typeof parsed !== "object" || parsed === null || !("address" in parsed)) throw new Error(out);
  const address = String(parsed.address);
  started.push(address);
  return address;
}

/** One space with no saved name or folder, its one tab a shell started at the root. */
const seedAtRoot = (): void =>
  seedSpaces([
    { id: "spc-root", name: "", folder: "", tabs: [{ id: "tb-root", name: "", terminal: startIn("/", "at-root") }] },
  ]);

test.afterEach(() => {
  for (const address of started.splice(0)) endAgent("host", address);
});

const spacesRegion = (page: Page) =>
  page.getByRole("complementary", { name: "Workspace" }).getByRole("region", { name: "Spaces" });

test("on a desktop the space reads its shell, Bash, and no row is named after the root", async ({ page }) => {
  seedAtRoot();
  await page.goto("/");
  const spaces = rows(spacesRegion(page));
  await expect(spaces.filter({ hasText: "Bash" })).toHaveCount(1, { timeout: 20_000 });
  await expect(spaces.filter({ hasText: /^\s*\/\s*$/ })).toHaveCount(0);
});

test.describe("on a phone at 390x844", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the Spaces list reads Bash, and the space's own screen is titled Bash", async ({ page }) => {
    seedAtRoot();
    await page.goto("/?v=spaces");
    const row = page.getByRole("button", { name: /^Bash\b/ }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    await expect(page.getByRole("heading", { level: 1, name: "Bash" })).toBeVisible({ timeout: 10_000 });
  });
});
