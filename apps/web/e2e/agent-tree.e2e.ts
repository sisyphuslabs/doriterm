import type { Locator, Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endAgent, startAgent } from "./agents.ts";
import { E2E_HOST_ENV } from "./config.ts";
import { expect, laidOutBox, test } from "./fixtures.ts";
import { MACHINE_NAME } from "./machine.ts";
import { hcOn } from "./machine-switch.ts";
import { readSavedEnv } from "./saved-env.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { rows } from "./sidebar-measure.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

endOwnTerminals();

const SPACE = "tree2746";

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Workspace" });

const section = (page: Page, title: string) => sidebar(page).getByRole("region", { name: title, exact: true });

const rowNamed = (scope: Locator, name: string) =>
  rows(scope).filter({ has: scope.page().locator(`[data-floor="name"][title="${name}"]`) });

const foldOf = (scope: Locator, name: string) => rowNamed(scope, name).locator("..").locator("[data-agent-fold]");

/**
 * A helper another agent started that reports `state` and waits, as `startAgent` does, and is kept when that agent's
 * program ends (`--outlive-parent`): by default hc ends a helper with the agent that started it.
 */
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

/** The rows of a section that are this spec's agents, by the name each starts with, in the order they are drawn. */
const drawn = (page: Page, title: string) => rows(section(page, title)).filter({ hasText: /tree-/ });

test("a sub-agent is listed under the agent that started it, which is placed by its most urgent one (#2746)", async ({
  page,
}) => {
  const lead = startAgent("host", "tree-lead", "working", SPACE);
  startAgent("host", "tree-other", "blocked", SPACE);
  const worker = startHelper("tree-worker", "done", lead);
  await page.goto("/");

  // A helper that finished is its own news: the agent that started it stays in Working, with the helper under it.
  await expect(drawn(page, "Working")).toHaveText([/tree-lead/, /tree-worker/], { timeout: 20_000 });
  await expect(drawn(page, "Needs you")).toHaveText([/tree-other/]);
  await expect(drawn(page, "Done")).toHaveCount(0);

  // A helper two levels down that needs the person brings the whole chain to Needs you, depth first.
  startHelper("tree-probe", "blocked", worker);
  await expect(drawn(page, "Needs you")).toHaveText([/tree-lead/, /tree-worker/, /tree-probe/, /tree-other/], {
    timeout: 20_000,
  });
  await expect(drawn(page, "Working")).toHaveCount(0);

  // The agent that started them ends: its helpers stay listed, the first of them now a row of its own, in the order they started.
  endAgent("host", lead);
  await expect(drawn(page, "Needs you")).toHaveText([/tree-other/, /tree-worker/, /tree-probe/], { timeout: 20_000 });
});

test("a sub-agent an agent starts on the added machine is listed under it, and its urgency places it (#2779)", async ({
  page,
}) => {
  // The agent itself runs `hc run --on`, as an agent does: hc records its parent from the terminal it runs in.
  const { hc, env } = readSavedEnv(E2E_HOST_ENV);
  const dir = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "tree-cross-"));
  try {
    const child = join(dir, "child.sh");
    const lead = join(dir, "lead.sh");
    writeFileSync(child, "printf '\\033]7501;state=blocked\\033\\\\'; sleep 600; :\n");
    const core = Object.entries(env).map(([key, value]) => `${key}='${value}'`);
    const remote = ["run", "--on", MACHINE_NAME, "--bg", "--outlive-parent", "--name", "tree-cross-child"];
    writeFileSync(
      lead,
      [
        "printf '\\033]7501;state=working\\033\\\\'",
        `env ${core.join(" ")} '${hc}' ${remote.join(" ")} --label space=${SPACE} -- sh '${child}' >/dev/null`,
        "sleep 600; :",
      ].join("\n"),
    );
    hcOn("host", ["run", "--bg", "--name", "tree-cross-lead", "--label", `space=${SPACE}`, "--", "sh", lead]);
    await page.goto("/");

    const needsYou = section(page, "Needs you");
    await expect(drawn(page, "Needs you")).toHaveText([/tree-cross-lead/, /tree-cross-child/], { timeout: 20_000 });
    await expect(drawn(page, "Working")).toHaveCount(0);
    await expect(rowNamed(needsYou, "tree-cross-child").locator("[data-tree-guides]")).toHaveAttribute(
      "data-depth",
      "1",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a sub-agent its parent starts on the added machine's own core is listed under it (#2779)", async ({ page }) => {
  // Both run on the added machine: its core records the parent bare, and this machine's feed names it as an address.
  const lead = startAgent("machine", "tree-box-lead", "working", SPACE);
  startAgent("machine", "tree-box-child", "blocked", SPACE, lead);
  await page.goto("/");

  const needsYou = section(page, "Needs you");
  await expect(drawn(page, "Needs you")).toHaveText([/tree-box-lead/, /tree-box-child/], { timeout: 20_000 });
  await expect(drawn(page, "Working")).toHaveCount(0);
  await expect(rowNamed(needsYou, "tree-box-child").locator("[data-tree-guides]")).toHaveAttribute("data-depth", "1");
});

test("a child row is indented under its parent with depth-1 guides and a shifted status glyph", async ({ page }) => {
  const lead = startAgent("host", "tree-indent-lead", "working", SPACE);
  startHelper("tree-indent-child", "working", lead);
  await page.goto("/");

  const working = section(page, "Working");
  const parentRow = rowNamed(working, "tree-indent-lead");
  const childRow = rowNamed(working, "tree-indent-child");
  await expect(parentRow).toBeVisible({ timeout: 20_000 });
  await expect(childRow).toBeVisible({ timeout: 20_000 });

  await expect(parentRow.locator("[data-tree-guides]")).toHaveAttribute("data-depth", "0");
  await expect(childRow.locator("[data-tree-guides]")).toHaveAttribute("data-depth", "1");
  const [parentGlyph, childGlyph] = await Promise.all([
    laidOutBox(parentRow.getByRole("img", { name: "Working" })),
    laidOutBox(childRow.getByRole("img", { name: "Working" })),
  ]);
  expect(childGlyph.x).toBeGreaterThan(parentGlyph.x);
});

test("folding a parent hides its blocked child, surfaces the Needs you count and badge, and survives reload", async ({
  page,
}) => {
  const lead = startAgent("host", "tree-fold-lead", "working", SPACE);
  startHelper("tree-fold-child", "blocked", lead);
  await page.goto("/");

  const needsYou = section(page, "Needs you");
  const parentRow = rowNamed(needsYou, "tree-fold-lead");
  const childRow = rowNamed(needsYou, "tree-fold-child");
  await expect(parentRow).toBeVisible({ timeout: 20_000 });
  await expect(childRow).toBeVisible({ timeout: 20_000 });

  const fold = foldOf(needsYou, "tree-fold-lead");
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await fold.click();

  await expect(childRow).toHaveCount(0);
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(fold.locator("[data-numeric]")).toHaveText("1");
  await expect(needsYou.getByRole("button", { name: /Show 1 sub-agent of .*, 1 needs you/ })).toBeVisible();
  await expect(fold.getByRole("img", { name: "Needs you" })).toBeVisible();

  await fold.click();
  await expect(childRow).toBeVisible();
  await expect(fold).toHaveAttribute("aria-expanded", "true");

  await fold.click();
  await expect(childRow).toHaveCount(0);
  await expect(fold).toHaveAttribute("aria-expanded", "false");

  await page.reload();
  await expect(parentRow).toBeVisible({ timeout: 20_000 });
  await expect(foldOf(needsYou, "tree-fold-lead")).toHaveAttribute("aria-expanded", "false");
  await expect(childRow).toHaveCount(0);
});

test("a three-level chain draws depths 0/1/2 and folding the top hides both with count 2", async ({ page }) => {
  const top = startAgent("host", "tree-chain-a", "working", SPACE);
  const mid = startHelper("tree-chain-b", "working", top);
  startHelper("tree-chain-c", "working", mid);
  await page.goto("/");

  const working = section(page, "Working");
  const rowA = rowNamed(working, "tree-chain-a");
  const rowB = rowNamed(working, "tree-chain-b");
  const rowC = rowNamed(working, "tree-chain-c");
  await expect(rowC).toBeVisible({ timeout: 20_000 });

  await expect(rowA.locator("[data-tree-guides]")).toHaveAttribute("data-depth", "0");
  await expect(rowB.locator("[data-tree-guides]")).toHaveAttribute("data-depth", "1");
  await expect(rowC.locator("[data-tree-guides]")).toHaveAttribute("data-depth", "2");

  const fold = foldOf(working, "tree-chain-a");
  await fold.click();
  await expect(rowB).toHaveCount(0);
  await expect(rowC).toHaveCount(0);
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(fold.locator("[data-numeric]")).toHaveText("2");
});

test("keyboard roving reaches the fold button on ArrowRight and toggles it on Enter", async ({ page }) => {
  const lead = startAgent("host", "tree-kb-lead", "working", SPACE);
  startHelper("tree-kb-child", "working", lead);
  await page.goto("/");

  const working = section(page, "Working");
  const parentRow = rowNamed(working, "tree-kb-lead");
  const childRow = rowNamed(working, "tree-kb-child");
  const fold = foldOf(working, "tree-kb-lead");
  await expect(childRow).toBeVisible({ timeout: 20_000 });

  await parentRow.focus();
  await page.keyboard.press("ArrowRight");
  await expect(fold).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(childRow).toHaveCount(0);

  await page.keyboard.press("Enter");
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await expect(childRow).toBeVisible();
});

test("a list with no parent draws no depth guides above 0 and no fold controls", async ({ page }) => {
  startAgent("host", "tree-flat-only", "working", SPACE);
  await page.goto("/");

  const working = section(page, "Working");
  await expect(rowNamed(working, "tree-flat-only")).toBeVisible({ timeout: 20_000 });
  await expect(sidebar(page).locator("[data-agent-fold]")).toHaveCount(0);
  await expect(sidebar(page).locator('[data-tree-guides]:not([data-depth="0"])')).toHaveCount(0);
});

test("the icon rail stays flat: a folded agent's blocked helper keeps its own glyph, with no guides or fold control", async ({
  page,
}) => {
  const lead = startAgent("host", "tree-rail-lead", "working", SPACE);
  startHelper("tree-rail-child", "blocked", lead);
  await page.goto("/");

  const needsYou = section(page, "Needs you");
  await expect(rowNamed(needsYou, "tree-rail-child")).toBeVisible({ timeout: 20_000 });
  await foldOf(needsYou, "tree-rail-lead").click();
  await expect(rowNamed(needsYou, "tree-rail-child")).toHaveCount(0);

  await page.getByRole("separator", { name: "Resize sidebar" }).focus();
  await page.keyboard.press("Enter");
  await expect(sidebar(page)).toHaveAttribute("data-rail", "true");

  const glyphs = sidebar(page).getByRole("button", { name: /^tree-rail-/ });
  await expect(glyphs).toHaveCount(2);
  await expect(glyphs.nth(0)).toHaveAccessibleName(/^tree-rail-lead, Working/);
  await expect(glyphs.nth(1)).toHaveAccessibleName(/^tree-rail-child, Needs you/);
  await expect(sidebar(page).locator("[data-agent-fold]")).toHaveCount(0);
  await expect(sidebar(page).locator("[data-tree-guides]")).toHaveCount(0);
});
