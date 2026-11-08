import { expect, laidOutBox, test } from "./fixtures.ts";
import { devices, type Locator, type Page } from "@playwright/test";
import { rowEdges, rows, visibleCharacters } from "./sidebar-measure.ts";
import {
  clearMachineLayout,
  KOREAN_SPACE,
  KOREAN_TITLE,
  LONG_MACHINE,
  machineConnected,
  renameMachine,
  SEEDS,
  seedLayouts,
  SHARED_SPACE,
  start,
  stop,
} from "./sidebar-seed.ts";
import { machineCore, setCoreDoc } from "./core-doc.ts";

/** What the macOS app sets beside its window buttons (apps/desktop TITLEBAR_INSET_START), and removes in full screen. */
const TITLEBAR_INSET_START = 78;
const MAC_INSET_CSS = `:root { --titlebar-inset-start: ${TITLEBAR_INSET_START}px; }`;

/** Hides the sidebar with the titlebar's toggle and returns that toggle, which now brings it back (#415). */
async function hideSidebar(page: Page): Promise<Locator> {
  const sidebar = page.getByRole("complementary", { name: "Workspace" });
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await expect(sidebar).toBeHidden();
  return page.getByRole("button", { name: "Show sidebar" });
}

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

let addresses: readonly string[] = [];
let restore = (): void => {};
test.beforeAll(async () => {
  restore = renameMachine();
  await machineConnected(LONG_MACHINE);
  addresses = SEEDS.map((seed) => start(seed, LONG_MACHINE));
});
// The page fixture starts each test with no layout on this core, so the seeds' spaces are saved again once it has.
test.beforeEach(({ page: _cleared }) => seedLayouts(addresses, LONG_MACHINE));
test.afterAll(() => {
  try {
    clearMachineLayout(LONG_MACHINE);
    stop(addresses);
  } finally {
    restore();
  }
});

/**
 * Counts the selected rows in the Spaces list after every change to the page, from its first render on, so a moment with
 * two selected spaces fails the test even when it is gone by the next assertion. `window.spacesSelection` keeps the
 * highest count and the rows marked at that moment.
 */
const WATCH_SPACES_SELECTION = `(() => {
  const record = { most: 0, rows: [] };
  window.spacesSelection = record;
  const count = () => {
    for (const section of document.querySelectorAll("section[aria-labelledby]")) {
      const heading = document.getElementById(section.getAttribute("aria-labelledby") ?? "");
      if (heading?.textContent?.trim() !== "Spaces") continue;
      const marked = [...section.querySelectorAll('[aria-current="true"]')];
      if (marked.length > record.most) {
        record.most = marked.length;
        record.rows = marked.map((row) => row.textContent ?? "");
      }
    }
  };
  new MutationObserver(count).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-current"],
  });
})();`;

interface SpacesSelection {
  readonly most: number;
  readonly rows: readonly string[];
}

test.afterEach(() => setCoreDoc("doriface", null));

/** Every row of the Idle and Spaces lists ends inside its content box, so every age ends at one edge. */
async function expectRowsInside(page: Page): Promise<void> {
  const idleRows = await rowEdges(rows(page.getByRole("region", { name: "Idle" })));
  const spaceRows = await rowEdges(rows(page.getByRole("region", { name: "Spaces" })));
  for (const row of [...idleRows, ...spaceRows]) expect(row.overflow).toBeLessThanOrEqual(0.5);
  const ages = idleRows.map((row) => row.age ?? Number.NaN);
  expect(Math.max(...ages) - Math.min(...ages), "every age ends at the same edge").toBeLessThanOrEqual(0.5);
}

/**
 * Every row stays inside its list (see expectRowsInside), and every cut text keeps a share before its ellipsis:
 * the name five characters; when the row cannot hold five of each, the machine gives way to three first, then the
 * detail, then the name. `nameFive` says the list is wide enough for every name to keep five; `fiveEach` holds rows
 * whose texts and machine always fit five each.
 */
async function expectRowsKeepFloors(
  page: Page,
  nameFive: boolean,
  fiveEach: (narrow: boolean) => boolean,
): Promise<void> {
  await expectRowsInside(page);
  const idle = page.getByRole("region", { name: "Idle" });
  const spaces = page.getByRole("region", { name: "Spaces" });
  const remote = rows(idle).filter({ hasText: "OmO - Verify bun" });

  const cases = [
    { row: remote, name: "OmO - Verify bun benchmarks on the box", detail: SHARED_SPACE, narrow: true },
    {
      row: rows(idle).filter({ hasText: "OmO - Draft the" }),
      name: "OmO - Draft the onboarding docs",
      detail: KOREAN_SPACE,
      narrow: false,
    },
    {
      row: rows(idle).filter({ hasText: KOREAN_TITLE.slice(0, 4) }),
      name: KOREAN_TITLE,
      detail: KOREAN_SPACE,
      narrow: false,
    },
  ];
  await Promise.all(
    cases.map(async ({ row, name: title, detail, narrow }) => {
      const kept = await Promise.all(
        [title, detail, LONG_MACHINE].map(async (text) => {
          const part = row.getByTitle(text, { exact: true });
          await expect(part, `a part of the row carries "${text}" as its title`).toHaveCount(1);
          await expect.soft(part).toHaveText(text);
          const { visible, total } = await visibleCharacters(part, text);
          return { text, visible, five: Math.min(5, total), three: Math.min(3, total) };
        }),
      );
      const [named, detailed, machine] = kept;
      for (const part of kept)
        expect(part.visible, `"${part.text}" keeps three characters`).toBeGreaterThanOrEqual(part.three);
      if (nameFive) expect(named?.visible, `"${title}" keeps five characters`).toBeGreaterThanOrEqual(named?.five ?? 5);
      if ((machine?.visible ?? 0) >= 5) {
        expect(detailed?.visible, `"${detail}" keeps as many as the machine`).toBeGreaterThanOrEqual(
          detailed?.five ?? 5,
        );
      }
      if (fiveEach(narrow)) {
        for (const part of kept)
          expect(part.visible, `"${part.text}" keeps five characters`).toBeGreaterThanOrEqual(part.five);
      }
    }),
  );

  // A space on the long-named machine keeps five characters of its name before the machine's; a phone lists them on its
  // Spaces tab.
  const tabs = page.getByRole("navigation", { name: "Sections" });
  const phone = (await tabs.count()) > 0;
  if (phone) await tabs.getByRole("button", { name: "Spaces", exact: true }).click();
  await Promise.all(
    [SHARED_SPACE, KOREAN_SPACE].map(async (name) => {
      const group = spaces.getByRole("region", { name: LONG_MACHINE, exact: true });
      const there = rows(group).filter({ hasText: name });
      const named = there.getByTitle(name, { exact: true });
      await expect(named).toHaveText(name);
      await expect(group.locator("[data-machine-header]").getByTitle(LONG_MACHINE, { exact: true })).toHaveText(
        LONG_MACHINE,
      );
      const { visible, total } = await visibleCharacters(named, name);
      expect(visible, `the space "${name}" keeps five characters`).toBeGreaterThanOrEqual(Math.min(5, total));
    }),
  );
}

/**
 * Waits for the sidebar's width to finish easing (a new --sidebar-width eases like a drag does), then two frames, so a
 * ResizeObserver has reported and any refit has been laid out.
 */
const settle = (page: Page) =>
  page.evaluate(async () => {
    const aside = document.querySelector("aside");
    await Promise.all((aside?.getAnimations() ?? []).map((animation) => animation.finished));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
const VIEWPORTS = [
  { name: "1470x956@2", use: { viewport: { width: 1470, height: 956 }, deviceScaleFactor: 2 } },
  { name: "1280x800@1", use: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 } },
  { name: "390", use: phone },
] as const;

for (const { name, use } of VIEWPORTS) {
  test.describe(`at ${name}`, () => {
    test.use(use);

    test("rows naming a long machine stay inside the list, every cut text keeps a share, an ellipsis and its tooltip, and they refit when the list narrows", async ({
      page,
    }) => {
      await page.goto("/");
      const remote = page
        .getByRole("region", { name: "Idle" })
        .locator("button:not([aria-label])")
        .filter({ hasText: "OmO - Verify bun" });
      await expect(remote).toBeVisible({ timeout: 20_000 });
      const phoneList = name === "390";
      // Two narrow texts and a narrow machine always fit five, and so does everything on a phone.
      await expectRowsKeepFloors(page, true, (narrow) => narrow || phoneList);
      const machines = page.getByRole("region", { name: "Spaces" });
      await expect(machines.getByTitle(LONG_MACHINE, { exact: true }).first()).toHaveText(LONG_MACHINE);
      if (phoneList) {
        await page.goBack();
        await expect(page.getByRole("region", { name: "Idle" })).toBeVisible();
      }

      // Narrower than where the floors were fitted: without a refit the parts keep widths the row no longer holds and run
      // past its edge.
      if (phoneList) await page.setViewportSize({ width: 320, height: 640 });
      else await page.evaluate(() => document.documentElement.style.setProperty("--sidebar-width", "15.5rem"));
      await settle(page);
      await expectRowsInside(page);
    });
  });
}

test.describe("with an age wider than its 28 px column, as Linux fonts draw <1m", () => {
  test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

  test("every age still ends at one edge, down to a list too narrow for three characters of each part", async ({
    page,
  }) => {
    // Wider glyphs from the first render, so the rows are fitted around the wide ages as they are on Linux.
    await page.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => {
        const style = document.createElement("style");
        style.textContent = "aside time { letter-spacing: 3px; }";
        document.head.append(style);
      });
    });
    await page.goto("/");
    const idle = page.getByRole("region", { name: "Idle" });
    await expect(rows(idle).filter({ hasText: "OmO - Verify bun" })).toBeVisible({ timeout: 20_000 });
    const widest = await idle.locator("time").evaluateAll((ages) => Math.max(...ages.map((age) => age.scrollWidth)));
    expect(widest, "the case is exercised: an age is wider than 28 px").toBeGreaterThan(28);
    await expectRowsInside(page);
    // Each width in turn: a list too narrow for three characters of each part shrinks them instead of spilling.
    const narrowTo = async (width: string): Promise<void> => {
      await page.evaluate((value) => document.documentElement.style.setProperty("--sidebar-width", value), width);
      await settle(page);
      await expectRowsInside(page);
    };
    await narrowTo("15.5rem");
    await narrowTo("14rem");
    await narrowTo("12rem");
  });
});

test("a hidden sidebar comes back from a named button at the window's left edge, by click, keyboard or shortcut", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "platform", { get: () => "Linux x86_64" });
    Object.defineProperty(Navigator.prototype, "userAgent", { get: () => "Mozilla/5.0 (X11; Linux x86_64)" });
  });
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "Workspace" });
  await rows(sidebar.getByRole("region", { name: "Spaces" }))
    .first()
    .click({ timeout: 20_000 });
  const show = await hideSidebar(page);
  const tablist = page.getByRole("tablist", { name: "Tabs" });
  const [button, tabs] = await Promise.all([laidOutBox(show), laidOutBox(tablist)]);
  expect(button.x).toBeLessThan(24);
  expect(button.x + button.width).toBeLessThanOrEqual(tabs.x);

  // The toggle that was just pressed keeps its tooltip closed until the pointer leaves it, so come back to it.
  await page.mouse.move(button.x + button.width / 2, button.y + 200);
  await show.hover();
  await expect(page.locator("[data-side]").filter({ hasText: "Show sidebar" }).first()).toBeVisible();
  await tablist.getByRole("tab").first().focus();
  await page.keyboard.press("Shift+Tab");
  await expect(show).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(sidebar).toBeVisible();

  await page.keyboard.press("Control+Shift+B");
  await expect(sidebar).toBeHidden();
  await page.keyboard.press("Control+Shift+B");
  await expect(sidebar).toBeVisible();
});

test("with the macOS app's titlebar inset, the button that brings the sidebar back starts past the window buttons", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("complementary", { name: "Workspace" })).toBeVisible({ timeout: 20_000 });
  await page.addStyleTag({ content: MAC_INSET_CSS });
  const box = await laidOutBox(await hideSidebar(page));
  expect(box.x).toBe(TITLEBAR_INSET_START);
});

// The machine order is the person's (#141), kept in the core's `doriface` document: the same-named spaces must open on
// their own machine whichever machine the person put first, so the test runs in both orders and leaves none behind.
const ORDERS = [
  { title: "in the default order", order: (): unknown => null },
  {
    title: "with the other machine ordered first",
    order: (): unknown => ({ machine_order: [machineCore(LONG_MACHINE)] }),
  },
] as const;

for (const { title, order } of ORDERS) {
  test(`a space named like one on another machine is selected, and opened, on its own machine only, ${title}`, async ({
    page,
  }) => {
    setCoreDoc("doriface", order());
    await page.addInitScript(WATCH_SPACES_SELECTION);
    await page.goto("/");
    const spaces = page.getByRole("region", { name: "Spaces" });
    const shared = rows(spaces).filter({ hasText: SHARED_SPACE });
    await expect(shared).toHaveCount(2, { timeout: 20_000 });
    // Each machine's spaces sit under its own header, in the order the person put the machines. This machine's group is
    // the one whose header says so; never "the first group", which the machine order can move.
    const thisMachine = spaces
      .locator("[data-drag-id]")
      .filter({ has: page.locator("[data-machine-header]").filter({ hasText: "this machine" }) });
    const here = rows(thisMachine).filter({ hasText: SHARED_SPACE });
    const there = rows(spaces.getByRole("region", { name: LONG_MACHINE, exact: true })).filter({
      hasText: SHARED_SPACE,
    });
    const focused = page.locator('[data-focused="true"] [data-terminal]');

    await here.click();
    await expect(focused).toHaveAttribute("data-terminal", /^t[0-9a-z]+$/, { timeout: 15_000 });
    await expect(here).toHaveAttribute("aria-current", "true");
    await expect(spaces.locator('[aria-current="true"]')).toHaveCount(1);

    await there.click();
    await expect(focused).toHaveAttribute("data-terminal", new RegExp(`^${LONG_MACHINE}/t[0-9a-z]+$`), {
      timeout: 15_000,
    });
    await expect(there).toHaveAttribute("aria-current", "true");
    await expect(spaces.locator('[aria-current="true"]')).toHaveCount(1);
    const seen = await page.evaluate(() => (window as unknown as { spacesSelection: SpacesSelection }).spacesSelection);
    expect(seen.most, `at most one space was ever selected; at the peak: ${seen.rows.join(" | ")}`).toBe(1);
  });
}
