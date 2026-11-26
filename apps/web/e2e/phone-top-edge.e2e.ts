import { devices, type Page } from "@playwright/test";
import { AGENT_SHELL, agentRow } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { seedSpaces } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { fakeSoftKeyboard, key } from "./phone-key-bar.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
test.use({ ...phone, serviceWorkers: "block" });

endOwnTerminals();

/**
 * The page's iOS-only rules (styles.css's `@supports (-webkit-touch-callout: none)`), applied as they are on an iPhone:
 * headless Chromium does not match the test, so the shipped rules are copied into a sheet of their own.
 */
async function applyIosRules(page: Page): Promise<void> {
  await page.evaluate(() => {
    const rules: string[] = [];
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (!(rule instanceof CSSSupportsRule) || !rule.conditionText.includes("touch-callout")) continue;
        for (const inner of rule.cssRules) rules.push(inner.cssText);
      }
    }
    if (rules.length === 0) throw new Error("no iOS rules in the page's styles");
    const ios = new CSSStyleSheet();
    ios.replaceSync(rules.join("\n"));
    document.adoptedStyleSheets = [ios];
  });
}

interface TopEdge {
  /** The strip is what WebKit's first pass (which ignores pointer-events) hits 4 px under the top centre. */
  readonly strip: boolean;
  /** Without the strip: the first fixed or sticky box there, which WebKit would take instead. */
  readonly under: { titlebar: boolean; position: string; width: number; height: number; background: string } | null;
}

/** What WebKit finds at the top edge (LocalFrameView::fixedContainerEdges), with and without the strip. */
async function topEdge(page: Page): Promise<TopEdge> {
  await applyIosRules(page);
  return page.evaluate(() => {
    const strip = document.querySelector<HTMLElement>("[data-top-edge]");
    if (strip === null) throw new Error("the page has no top-edge strip");
    const x = window.innerWidth / 2;
    strip.style.pointerEvents = "auto";
    const first = document.elementFromPoint(x, 4);
    strip.style.pointerEvents = "";
    strip.style.display = "none";
    let box = document.elementFromPoint(x, 4);
    strip.style.display = "";
    while (box !== null && !["fixed", "sticky"].includes(getComputedStyle(box).position)) box = box.parentElement;
    if (box === null) return { strip: first === strip, under: null };
    const rect = box.getBoundingClientRect();
    const style = getComputedStyle(box);
    return {
      strip: first === strip,
      under: {
        titlebar: box.hasAttribute("data-titlebar"),
        position: style.position,
        width: rect.width / window.innerWidth,
        height: rect.height,
        background: style.backgroundColor,
      },
    };
  });
}

/** The strip takes the top, and under it the screen's own header would: wide, over 10 px, a solid colour. */
async function expectHeaderEdge(page: Page, screen: string): Promise<void> {
  const edge = await topEdge(page);
  expect(edge.strip, `${screen}: the strip is the top edge`).toBe(true);
  expect(edge.under?.titlebar, `${screen}: under the strip, the header is the edge`).toBe(true);
  expect(edge.under?.position).toBe("sticky");
  expect(edge.under?.width ?? 0).toBeGreaterThanOrEqual(0.9);
  expect(edge.under?.height ?? 0).toBeGreaterThan(10);
  expect(edge.under?.background ?? "", `${screen}: the header's colour is solid`).toMatch(/^rgb\(/);
}

function startShellIn(space: string, name: string): string {
  const out = hcOn("host", ["run", "--bg", "--name", name, "--label", `space=${space}`, "--", ...AGENT_SHELL]);
  const started: unknown = JSON.parse(out);
  if (typeof started !== "object" || started === null || !("address" in started)) throw new Error(out);
  return String(started.address);
}

test("every phone screen and sheet gives iOS a solid top edge, so its blur stays off the headers (#2867)", async ({
  page,
}) => {
  const run = Date.now().toString(36);
  const space = `pte-${run}`;
  const name = `pte-here-${run}`;
  const terminal = startShellIn(space, name);
  seedSpaces([{ id: "spc-pte", name: space, folder: "", tabs: [{ id: "tb-pte", name: "", terminal }] }]);
  await fakeSoftKeyboard(page);
  await page.goto("/");

  // No rubber band at the top: iOS shows its blur while the page is pulled past its top.
  const overscroll = await page.evaluate(() =>
    [document.documentElement, document.body].map((element) => getComputedStyle(element).overscrollBehaviorY),
  );
  expect(overscroll).toEqual(["none", "none"]);

  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  await expectHeaderEdge(page, "Agents");

  const sections = page.getByRole("navigation", { name: "Sections" });
  await sections.getByRole("button", { name: "Spaces", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Spaces", exact: true })).toBeVisible();
  await expectHeaderEdge(page, "Spaces");

  await page
    .getByRole("button", { name: new RegExp(`^${space}\\b`) })
    .first()
    .click();
  await expect(page.getByRole("button", { name: "Back to Spaces" })).toBeVisible({ timeout: 20_000 });
  await expectHeaderEdge(page, "a space");

  await page.getByRole("button", { name: "Back to Spaces" }).click();
  await sections.getByRole("button", { name: /^Agents\b/ }).click();
  await agentRow(page, name, false).click();
  const actions = page.getByRole("banner").getByRole("button", { name: `Session actions for ${name}`, exact: true });
  await expect(actions).toBeVisible({ timeout: 15_000 });
  await expectHeaderEdge(page, "a terminal");

  // With the keyboard up the header is still the edge, and the page has not scrolled under the blur.
  await key(page, "Show keyboard").click();
  await expect(key(page, "Hide keyboard")).toBeVisible();
  await expectHeaderEdge(page, "a terminal with the keyboard up");
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  // A sheet over the screen: its scrim is under the strip, so the strip stays the edge.
  await actions.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect((await topEdge(page)).strip, "a sheet: the strip is the top edge").toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.goto("/settings");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible({ timeout: 20_000 });
  await expectHeaderEdge(page, "Settings");
});
