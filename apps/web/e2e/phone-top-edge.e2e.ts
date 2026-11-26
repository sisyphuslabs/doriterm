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
    // A rule inside a cascade layer is copied into that layer, so it wins or loses as it does on an iPhone.
    const collect = (list: CSSRuleList, layer: string | null): void => {
      for (const rule of list) {
        if (rule instanceof CSSLayerBlockRule) collect(rule.cssRules, rule.name);
        else if (rule instanceof CSSSupportsRule && rule.conditionText.includes("touch-callout")) {
          for (const inner of rule.cssRules)
            rules.push(layer === null ? inner.cssText : `@layer ${layer} { ${inner.cssText} }`);
        } else if (rule instanceof CSSGroupingRule) collect(rule.cssRules, layer);
      }
    };
    for (const sheet of document.styleSheets) collect(sheet.cssRules, null);
    if (rules.length === 0) throw new Error("no iOS rules in the page's styles");
    const ios = new CSSStyleSheet();
    ios.replaceSync(rules.join("\n"));
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, ios];
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
  // A screen sliding in is measured where it comes to rest: its finite animations (not a status pulse) have ended.
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every((animation) => animation.playState !== "running" || animation.effect?.getTiming().iterations === Infinity),
  );
  await applyIosRules(page);
  return page.evaluate(() => {
    const strip = document.querySelector<HTMLElement>("[data-top-edge]");
    if (strip === null) throw new Error("the page has no top-edge strip");
    const x = window.innerWidth / 2;
    // WebKit's first pass ignores pointer-events, elementFromPoint does not: every box takes the hit while it looks.
    const everyBox = new CSSStyleSheet();
    everyBox.replaceSync("* { pointer-events: auto !important; }");
    const sheets = document.adoptedStyleSheets;
    document.adoptedStyleSheets = [...sheets, everyBox];
    const first = document.elementFromPoint(x, 4);
    strip.style.display = "none";
    let box = document.elementFromPoint(x, 4);
    strip.style.display = "";
    document.adoptedStyleSheets = sheets;
    while (box !== null && !["fixed", "sticky"].includes(getComputedStyle(box).position)) box = box.parentElement;
    if (box === null) return { strip: first === strip, under: null };
    const rect = box.getBoundingClientRect();
    const style = getComputedStyle(box);
    return {
      strip: first === strip,
      under: {
        titlebar: box.hasAttribute("data-phone-top"),
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
  await applyIosRules(page);
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

  // With the keyboard up iOS scrolls the document to show the field (#2847): the header stays at the top, still the edge.
  await key(page, "Show keyboard").click();
  await expect(key(page, "Hide keyboard")).toBeVisible();
  const scrolled = await page.evaluate(() => {
    const room = document.createElement("div");
    room.id = "pte-room";
    room.style.height = "1200px";
    document.body.append(room);
    window.scrollTo(0, 120);
    return window.scrollY;
  });
  expect(scrolled, "the document really scrolled").toBe(120);
  const headerTop = await page
    .locator("header[data-phone-top]")
    .evaluate((header) => header.getBoundingClientRect().top);
  expect(headerTop, "the header stays at the top of the screen").toBe(0);
  await expectHeaderEdge(page, "a terminal with the keyboard up and the document scrolled");
  await page.evaluate(() => {
    document.getElementById("pte-room")?.remove();
    window.scrollTo(0, 0);
  });

  // A sheet over the screen: its scrim is under the strip, so the strip stays the edge.
  await actions.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect((await topEdge(page)).strip, "a sheet: the strip is the top edge").toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.goto("/settings");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible({ timeout: 20_000 });
  await expectHeaderEdge(page, "Settings");
  // Under a notch the title row starts at the very top and keeps its title below the inset.
  await page.evaluate(() => document.documentElement.style.setProperty("--safe-top", "47px"));
  const row = page.getByRole("heading", { level: 1, name: "Settings" }).locator("xpath=ancestor::*[@data-phone-top]");
  expect(await row.evaluate((element) => element.getBoundingClientRect().top)).toBe(0);
  const title = await page.getByRole("heading", { level: 1, name: "Settings" }).boundingBox();
  expect(title?.y ?? 0, "the title clears the inset").toBeGreaterThanOrEqual(47);
  await expectHeaderEdge(page, "Settings under a notch");
});

test("a phone on its side shows Settings' wide nav, whose title row stays in its column (#2867)", async ({ page }) => {
  // Wider than md and shorter than the dialog: the full-screen sheet with the nav column, whose row is not a phone header.
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto("/settings");
  const nav = page.getByRole("navigation", { name: "Settings" });
  await expect(nav.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-phone-top]:visible")).toHaveCount(0);
  const row = nav.locator("[data-titlebar]");
  const before = await row.evaluate((element) => getComputedStyle(element).position);
  await applyIosRules(page);
  expect(await row.evaluate((element) => getComputedStyle(element).position)).toBe(before);
});

// An iPad shows the desktop shell (medium in portrait, wide in landscape, width-tier.ts), whose titlebar pieces are
// absolute or fixed: the iOS rules move none of them, in place, size or stacking, and no phone row is marked there.
for (const device of ["iPad Pro 11", "iPad Pro 11 landscape"] as const) {
  test.describe(`on an ${device}`, () => {
    const { defaultBrowserType: _ipadBrowser, ...ipad } = devices[device];
    // The iPad descriptors carry no screen, and the file's iPhone screen (390x844) would make the app a phone.
    test.use({ ...ipad, screen: ipad.viewport });

    for (const path of ["/", "/settings"]) {
      test(`at ${path} the iOS rules leave every titlebar piece where it is (#2867)`, async ({ page }) => {
        const positions = () =>
          page.locator("[data-titlebar]").evaluateAll((boxes) =>
            boxes.map((box) => {
              const { position, zIndex } = getComputedStyle(box);
              const { top, left, width, height } = box.getBoundingClientRect();
              return `${box.className.slice(0, 40)}: ${position} z${zIndex} ${top},${left} ${width}x${height}`;
            }),
          );
        await page.goto(path);
        // The desktop shell, once it has drawn (behind Settings' dialog too): its sidebar toggle is in the page, and two
        // readings of the titlebar pieces in a row agree.
        await expect(page.locator('button[aria-label$="sidebar"]').first()).toBeAttached({ timeout: 20_000 });
        let last = "";
        await expect
          .poll(async () => {
            const now = JSON.stringify(await positions());
            const settled = now === last && now !== "[]";
            last = now;
            return settled;
          })
          .toBe(true);
        // No row there is a phone header: a marked one would turn sticky over the desktop layout.
        await expect(page.locator("[data-phone-top]:visible")).toHaveCount(0);
        const before = await positions();
        await applyIosRules(page);
        expect(await positions(), "no titlebar piece moves").toEqual(before);
      });
    }
  });
}
