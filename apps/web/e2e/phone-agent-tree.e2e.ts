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
  const reachY = 21.5;
  const points = [
    { x: Math.max(1, box.x - 23.5), y: midY },
    { x: box.x + box.width, y: midY },
    { x: midX, y: midY - reachY },
    { x: midX, y: midY + reachY },
  ];
  expect(await reached(page, points)).toEqual([true, true, true, true]);
  expect(await reached(page, [{ x: g0.x + g0.width / 2, y: g0.y + g0.height / 2 }])).toEqual([false]);

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

  const glyph = await laidOutBox(r0.getByRole("img", { name: "Working" }));
  await page.touchscreen.tap(glyph.x + glyph.width / 2, glyph.y + glyph.height / 2);
  const back = page.getByRole("button", { name: "Back to agents" });
  await expect(back).toBeVisible();
  await expect(page.locator(`[data-terminal="${p0}"]`)).toBeVisible();

  await back.tap();
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await expect(r1).toBeVisible();
  await expect(r2).toBeVisible();
  await expect(r3).toBeVisible();
});

test("the Needs you header says what the Agents badge says: a working agent drawn there for its sub-agent is not counted (#2881)", async ({
  page,
}) => {
  const lead = startAgent("host", "ptree-count-lead", "working", SPACE);
  startHelper("ptree-count-probe", "blocked", lead);

  await page.goto("/");
  const needsYou = page.getByRole("region", { name: "Needs you", exact: true });
  await expect(rowNamed(needsYou, "ptree-count-probe")).toBeVisible({ timeout: 20_000 });
  await expect(rowNamed(needsYou, "ptree-count-lead")).toBeVisible();
  const badge = page
    .getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: /^Agents\b/ })
    .locator("[data-slot='tab-badge']");
  await expect(badge).toHaveText("1");
  await expect(needsYou.locator("header [data-numeric]")).toHaveText("1");
});
