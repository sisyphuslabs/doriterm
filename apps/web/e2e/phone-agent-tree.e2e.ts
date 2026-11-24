import { devices, type Locator, type Page } from "@playwright/test";
import { startAgent } from "./agents.ts";
import { expect, laidOutBox, test } from "./fixtures.ts";
import { hcOn } from "./machine-switch.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { rows } from "./sidebar-measure.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
test.use({ ...phone, serviceWorkers: "block" });

endOwnTerminals();

const SPACE = "ptree2746";

function startHelper(name: string, state: string, parent: string): string {
  const report = `printf '\\033]7501;state=${state}\\033\\\\'; sleep 600; :`;
  const out = hcOn("host", [
    "run",
    "--bg",
    "--parent",
    parent,
    "--outlive-parent",
    "--name",
    name,
    "--label",
    `space=${SPACE}`,
    "--",
    "sh",
    "-c",
    report,
  ]);
  const started: unknown = JSON.parse(out);
  if (typeof started !== "object" || started === null || !("address" in started)) throw new Error(out);
  return String(started.address);
}

const rowNamed = (scope: Locator, name: string) =>
  rows(scope).filter({ has: scope.page().locator(`[data-floor="name"][title="${name}"]`) });

const foldOf = (scope: Locator, name: string) => rowNamed(scope, name).locator("..").locator("[data-agent-fold]");

const reached = (page: Page, points: readonly { readonly x: number; readonly y: number }[]) =>
  page.evaluate(
    (at) =>
      at.map(
        ({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.hasAttribute("data-agent-fold") ?? false,
      ),
    points,
  );

test("on the phone, a 4-level chain caps guides at depth 2 and the fold button keeps a 44x44 touch target", async ({
  page,
}) => {
  const p0 = startAgent("host", "ptree-0", "working", SPACE);
  const p1 = startHelper("ptree-1", "working", p0);
  const p2 = startHelper("ptree-2", "working", p1);
  startHelper("ptree-3", "working", p2);

  await page.goto("/");
  const working = page.getByRole("region", { name: "Working", exact: true });
  const r0 = rowNamed(working, "ptree-0");
  const r1 = rowNamed(working, "ptree-1");
  const r2 = rowNamed(working, "ptree-2");
  const r3 = rowNamed(working, "ptree-3");
  await expect(r3).toBeVisible({ timeout: 20_000 });

  await expect(r0.locator("[data-tree-guides]")).toHaveAttribute("data-depth", "0");
  await expect(r1.locator("[data-tree-guides]")).toHaveAttribute("data-depth", "1");
  await expect(r2.locator("[data-tree-guides]")).toHaveAttribute("data-depth", "2");
  await expect(r3.locator("[data-tree-guides]")).toHaveAttribute("data-depth", "2");

  const [g0, g1, g2, g3] = await Promise.all([
    laidOutBox(r0.getByRole("img", { name: "Working" })),
    laidOutBox(r1.getByRole("img", { name: "Working" })),
    laidOutBox(r2.getByRole("img", { name: "Working" })),
    laidOutBox(r3.getByRole("img", { name: "Working" })),
  ]);
  expect(g1.x).toBeGreaterThan(g0.x);
  expect(g2.x).toBeGreaterThan(g1.x);
  expect(Math.abs(g3.x - g2.x)).toBeLessThanOrEqual(0.5);

  const fold = foldOf(working, "ptree-0");
  const box = await laidOutBox(fold);
  const afterBox = await fold.evaluate((el) => {
    const style = getComputedStyle(el, "::after");
    return { width: Number.parseFloat(style.width), height: Number.parseFloat(style.height) };
  });
  expect(afterBox.width).toBeGreaterThanOrEqual(44);
  expect(afterBox.height).toBeGreaterThanOrEqual(44);

  const midX = box.x + box.width / 2;
  const midY = box.y + box.height / 2;
  const reach = 21.5;
  const points = [
    { x: midX - reach, y: midY },
    { x: midX + reach, y: midY },
    { x: midX, y: midY - reach },
    { x: midX, y: midY + reach },
  ];
  expect(await reached(page, points)).toEqual([true, true, true, true]);

  await fold.tap();
  await expect(r1).toHaveCount(0);
  await expect(r2).toHaveCount(0);
  await expect(r3).toHaveCount(0);
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(fold.locator("[data-numeric]")).toHaveText("3");

  await fold.tap();
  await expect(r1).toBeVisible();
  await expect(r2).toBeVisible();
  await expect(r3).toBeVisible();
  await expect(fold).toHaveAttribute("aria-expanded", "true");
});
