import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { seedSpaces } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { rows } from "./sidebar-measure.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

let dir = "";
const started: string[] = [];
const NAMES = ["alpha673", "beta673", "gamma673"] as const;

function startIn(cwd: string, name: string): string {
  const out = hcOn("host", ["run", "--bg", "--name", name, "--cwd", cwd, "--", "sh", "-c", "exec sleep 600"]);
  const parsed: unknown = JSON.parse(out);
  if (typeof parsed !== "object" || parsed === null || !("address" in parsed)) throw new Error(out);
  const address = String(parsed.address);
  started.push(address);
  return address;
}

test.beforeAll(() => {
  dir = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "sidebar-filter-"));
  for (const name of NAMES) mkdirSync(join(dir, name), { recursive: true });
});
test.afterEach(() => {
  for (const address of started.splice(0)) endAgent("host", address);
});
test.afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("typing in the sidebar filter narrows spaces and agents by their labels, keeps the selected space, and Escape restores the lists (#673)", async ({
  page,
}) => {
  seedSpaces(
    NAMES.map((name) => ({
      id: `spc-${name}`,
      name,
      folder: join(dir, name),
      tabs: [{ id: `tb-${name}`, name, terminal: startIn(join(dir, name), `${name}-agent`) }],
    })),
  );
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "Workspace" });
  const spaces = sidebar.getByRole("region", { name: "Spaces" });
  const agents = sidebar.getByRole("region", { name: "Agents" });
  const spaceRow = (name: string) => rows(spaces).filter({ hasText: name });
  const agentRow = (name: string) => rows(agents).filter({ hasText: `${name}-agent` });
  await Promise.all(NAMES.map((name) => expect(spaceRow(name)).toHaveCount(1, { timeout: 20_000 })));
  await Promise.all(NAMES.map((name) => expect(agentRow(name)).toHaveCount(1, { timeout: 20_000 })));
  await spaceRow("alpha673").click();
  await expect(spaceRow("alpha673")).toHaveAttribute("aria-current", /.+/);
  // The rows' names, not the sidebar's whole text: an agent's age ticks over each minute.
  const rowNames = () =>
    rows(sidebar).evaluateAll((buttons) => buttons.map((row) => row.textContent?.replace(/\d+m|<1m/gu, "") ?? ""));
  const before = await rowNames();

  // The filter key opens the field with focus in it, from wherever focus was.
  await page.keyboard.press("Control+Alt+F");
  const field = sidebar.getByRole("searchbox", { name: "Filter sidebar" });
  await expect(field).toBeFocused();
  await page.keyboard.type("bet");

  await expect(spaceRow("beta673")).toHaveCount(1);
  await expect(spaceRow("gamma673")).toHaveCount(0);
  // The selected space does not match, and stays as context.
  await expect(spaceRow("alpha673")).toHaveCount(1);
  await expect(agentRow("beta673")).toHaveCount(1);
  await expect(agentRow("gamma673")).toHaveCount(0);

  // A query nothing shows matches no row, but the selected space.
  await field.fill("zzz673");
  await expect(spaceRow("beta673")).toHaveCount(0);
  await expect(spaceRow("alpha673")).toHaveCount(1);

  // Escape clears the query: the lists are back as they were.
  await page.keyboard.press("Escape");
  await expect(field).toHaveValue("");
  await Promise.all(NAMES.map((name) => expect(spaceRow(name)).toHaveCount(1)));
  await Promise.all(NAMES.map((name) => expect(agentRow(name)).toHaveCount(1)));
  // Escape on the empty field closes it and gives focus back to the terminal.
  await page.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-terminal]") !== null)).toBe(true);
  await expect.poll(rowNames).toEqual(before);
});

test("the filter button opens and closes the field (#673)", async ({ page }) => {
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "Workspace" });
  const button = sidebar.getByRole("button", { name: "Filter sidebar" });
  await button.click();
  await expect(sidebar.getByRole("searchbox", { name: "Filter sidebar" })).toBeFocused();
  await button.click();
  await expect(sidebar.getByRole("searchbox", { name: "Filter sidebar" })).toHaveCount(0);
});

test("behind the command palette the filter key does nothing: the palette keeps focus and the sidebar is left alone (#673)", async ({
  page,
}) => {
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "Workspace" });
  await expect(sidebar.getByRole("button", { name: "Filter sidebar" })).toBeVisible({ timeout: 15_000 });
  await sidebar.getByRole("button", { name: "Command palette" }).click();
  const palette = page.getByRole("dialog");
  await expect(palette).toBeVisible();
  const focused = await page.evaluate(() => document.activeElement?.outerHTML ?? "");
  await page.keyboard.press("Control+Alt+F");
  await expect(palette).toBeVisible();
  await expect(sidebar.getByRole("searchbox", { name: "Filter sidebar" })).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.outerHTML ?? "")).toBe(focused);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the phone list has no filter button, since it has no filter field (#673)", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "New tab" }).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/^Spaces$/).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Filter sidebar" })).toHaveCount(0);
  });
});
