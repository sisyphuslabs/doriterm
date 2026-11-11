import { endAgent, startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { rows } from "./sidebar-measure.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

let address = "";
test.beforeAll(() => {
  address = startAgent("host", "rc-shift", "working", "rc206shift");
});
test.afterAll(() => endAgent("host", address));

/**
 * Layout shifts on this page that moved a node in the sidebar, as the browser reports them from the first paint. A source
 * whose box is where it was is not a move: a count whose digit changes in place (a loose terminal adopted into its tab
 * as the workspace loads, #2129) is reported with a score of about 6e-7 and the same box before and after (#2321).
 */
const sidebarShift = () => {
  const shifts: PerformanceEntry[] = [];
  new PerformanceObserver((list) => shifts.push(...list.getEntries())).observe({
    type: "layout-shift",
    buffered: true,
  });
  Reflect.set(window, "__sidebarShift", () =>
    shifts
      .filter((shift) => Reflect.get(shift, "hadRecentInput") !== true)
      .filter((shift) => {
        const aside = document.querySelector("aside");
        const sources: unknown = Reflect.get(shift, "sources");
        return (
          Array.isArray(sources) &&
          sources.some((source: unknown) => {
            if (typeof source !== "object" || source === null) return false;
            const node: unknown = Reflect.get(source, "node");
            const before: unknown = Reflect.get(source, "previousRect");
            const after: unknown = Reflect.get(source, "currentRect");
            const moved =
              !(before instanceof DOMRectReadOnly) ||
              !(after instanceof DOMRectReadOnly) ||
              before.x !== after.x ||
              before.y !== after.y ||
              before.width !== after.width ||
              before.height !== after.height;
            return moved && node instanceof Node && aside?.contains(node) === true;
          })
        );
      })
      .reduce((sum, shift) => sum + Number(Reflect.get(shift, "value")), 0),
  );
};

test("loading the workspace moves nothing in the sidebar: the lists appear once, in place", async ({ page }) => {
  await page.addInitScript(sidebarShift);
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "Workspace" });
  await expect(
    rows(sidebar.getByRole("region", { name: "Working", exact: true })).filter({ hasText: "rc-shift" }),
  ).toBeVisible({
    timeout: 20_000,
  });
  await expect(sidebar.locator("[data-machine-header]").first()).toBeVisible({ timeout: 20_000 });
  // Two frames, so a shift caused by the last update has been reported.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const shift = await page.evaluate(() => {
    const measure: unknown = Reflect.get(window, "__sidebarShift");
    return typeof measure === "function" ? Number(measure()) : Number.NaN;
  });
  expect(shift).toBe(0);
});
