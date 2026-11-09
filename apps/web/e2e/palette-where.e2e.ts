import { devices, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  // Each terminal's own space label differs from the space the sidebar lists it in: the line must name the sidebar's.
  const one = startShellIn(`lbl-a-${run}`, `${twin}-a`);
  const two = startShellIn(`lbl-b-${run}`, `${twin}-b`);
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
  await expect(where(page)).not.toContainText("lbl-");
  const first = (await where(page).textContent()) ?? "";
  await page.keyboard.press("ArrowDown");
  await expect(where(page)).not.toHaveText(first);
  await expect(where(page)).toContainText(first.includes(`whr-a-${run}`) ? `whr-b-${run}` : `whr-a-${run}`);
  await expect(dialog(page).getByRole("option", { selected: true })).toHaveAccessibleDescription(/whr-[ab]-/);

  await page.getByRole("combobox", { name: "Command" }).fill("Split right");
  await expect(dialog(page).getByRole("option", { selected: true })).toContainText("Split right");
  await expect(where(page)).toHaveCount(0);
});

const { defaultBrowserType: _browser, ...PHONE } = devices["iPhone 14"];

test.describe("on a 390 px phone", () => {
  test.use({ ...PHONE, viewport: { width: 390, height: 844 } });

  test("the place line keeps the deepest directory in view, inside the dialog (#1475)", async ({ page }) => {
    const run = Date.now().toString(36);
    const root = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "palette-where-"));
    const deepest = `invoice-renderer-${run}`;
    const cwd = join(root, "projects", "clients", "northwind", "services", "billing-gateway", "packages", deepest);
    mkdirSync(cwd, { recursive: true });
    try {
      const name = `deep-${run}`;
      hcOn("host", ["run", "--bg", "--name", name, "--cwd", cwd, "--", "env", "PS1=$ ", "sh"]);
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
      await page.getByRole("button", { name: "Command palette" }).click();
      await page.getByRole("combobox", { name: "Command" }).fill(name);
      await expect(dialog(page).getByRole("option", { selected: true })).toContainText(name, { timeout: 15_000 });
      await expect(where(page)).toContainText(deepest);

      const frame = await dialog(page).boundingBox();
      const line = await where(page).boundingBox();
      expect(frame).not.toBeNull();
      expect(line).not.toBeNull();
      expect(line?.x ?? 0).toBeGreaterThanOrEqual(frame?.x ?? 0);
      expect((line?.x ?? 0) + (line?.width ?? 0)).toBeLessThanOrEqual((frame?.x ?? 0) + (frame?.width ?? 0));

      // The path is longer than the line, so something is clipped: the deepest segment must be drawn inside the line.
      const seen = await where(page).evaluate((element, segment) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const at = node.textContent?.lastIndexOf(segment) ?? -1;
          if (at < 0) continue;
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + segment.length);
          const ink = range.getBoundingClientRect();
          const clip = node.parentElement?.getBoundingClientRect() ?? element.getBoundingClientRect();
          const box = element.getBoundingClientRect();
          return {
            clipped:
              element.scrollWidth > element.clientWidth ||
              [...element.querySelectorAll("*")].some((e) => e.scrollWidth > e.clientWidth),
            inside:
              ink.left >= Math.max(clip.left, box.left) - 0.5 && ink.right <= Math.min(clip.right, box.right) + 0.5,
          };
        }
        return { clipped: false, inside: false };
      }, deepest);
      expect(seen.clipped).toBe(true);
      expect(seen.inside).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
