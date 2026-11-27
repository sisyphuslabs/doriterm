import type { Locator, Page } from "@playwright/test";
import { endAgent, startShell } from "./agents.ts";
import { SHOTS, type Shot } from "./capture-shots.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";

/** The shot a test ran: its cleanup runs after the test whatever the outcome, so a later spec starts as the host did. */
let ran: Shot | undefined;
test.afterEach(() => {
  ran?.cleanup?.();
  ran = undefined;
});

test.use({ serviceWorkers: "block" });

let shell = "";
test.beforeEach(() => {
  shell = startShell("host", "shell");
});
test.afterEach(() => {
  endAgent("host", shell);
});

/**
 * Every column (or, for controls stacked one over the other, every row) between two neighbouring controls, on the line
 * through both centres, that a pointer there would reach neither of. Sampled every quarter of a CSS pixel: a
 * high-density screen has three device pixels in one of these, so a sliver narrower than a pixel is still a place a
 * pointer lands on neither control. A pair one of whose controls is not reachable at its own centre (scrolled under the
 * paging cue) is not on screen to tap, so it has no seam.
 */
const unowned = async (left: Locator, right: Locator) =>
  left.evaluate(
    (a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const stacked = ra.bottom <= rb.top + 1;
      const x = (Math.max(ra.left, rb.left) + Math.min(ra.right, rb.right)) / 2;
      const y = (Math.max(ra.top, rb.top) + Math.min(ra.bottom, rb.bottom)) / 2;
      const reached = (el: Element, box: DOMRect) =>
        el.contains(
          document.elementFromPoint(stacked ? x : box.left + box.width / 2, stacked ? box.top + box.height / 2 : y),
        );
      if (!reached(a, ra) || !reached(b, rb)) return [];
      const step = 0.25;
      const from = (stacked ? ra.bottom : ra.right) - 1;
      const to = (stacked ? rb.top : rb.left) + 1;
      const seams: number[] = [];
      for (let at = from; at <= to; at += step) {
        const hit = stacked ? document.elementFromPoint(x, at) : document.elementFromPoint(at, y);
        if (hit === null || !(a.contains(hit) || b.contains(hit))) seams.push(Math.round(at * 100) / 100);
      }
      return seams;
    },
    await right.elementHandle(),
  );

const neighbours = async (controls: Locator) => {
  const all = await controls.all();
  return all.flatMap((left, i) => {
    const right = all[i + 1];
    return right === undefined ? [] : [[left, right] as const];
  });
};

const cases: readonly {
  name: string;
  width: 390 | 1440;
  pairs: (page: Page) => Promise<(readonly [Locator, Locator])[]>;
}[] = [
  {
    name: "workspace",
    width: 1440,
    pairs: async (page) => {
      await page.goto("/");
      const items = page.getByRole("tablist", { name: "Tabs" }).locator("[data-tab-id]");
      // The workspace opens the shell that is already running in a tab of its own.
      await expect(items).toHaveCount(1, { timeout: 20_000 });
      await openNewTerminal(page);
      await expect(items).toHaveCount(2);
      // A new tab arrives from scale(0.97): measured once its arrival has settled, as tab-strip-herdr does.
      await items.evaluateAll(async (elements) =>
        Promise.all(elements.flatMap((element) => element.getAnimations().map((animation) => animation.finished))),
      );
      const [first, second] = [items.nth(0), items.nth(1)];
      const active = page.getByRole("tab", { selected: true }).locator("..");
      return [
        // Two tabs side by side: the 3 px between their boxes, and a tab and its Close button.
        [first, second],
        [active.getByRole("tab"), active.locator("[data-tab-close]")],
      ];
    },
  },
  {
    name: "settings",
    width: 390,
    // The phone's list of sections (#2914): neighbouring rows of one card, whose gaps between cards are on purpose.
    pairs: async (page) =>
      (
        await Promise.all(
          (await page.locator("[data-settings-list] [data-settings-card]").all()).map((card) =>
            neighbours(card.getByRole("button")),
          ),
        )
      ).flat(),
  },
  {
    name: "settings-voice-input",
    width: 390,
    pairs: (page) => neighbours(page.getByRole("group", { name: "Speech recognition" }).getByRole("button")),
  },
  {
    name: "settings-voice-input",
    width: 1440,
    pairs: (page) => neighbours(page.getByRole("group", { name: "Speech recognition" }).getByRole("button")),
  },
];

for (const { name, width, pairs } of cases) {
  test.describe(`${width}`, () => {
    test.use({
      viewport: { width, height: width === 390 ? 844 : 900 },
      hasTouch: width === 390,
      isMobile: width === 390,
      deviceScaleFactor: width === 390 ? 3 : 1,
    });
    test(`${name}: neighbouring bar controls leave no dead pixel column between them`, async ({ page }) => {
      const shot = SHOTS.find((entry) => entry.name === name);
      if (shot === undefined) throw new Error(`capture ${name} is missing`);
      ran = shot;
      if (name !== "workspace") await shot.run(page, width === 390 ? "390" : "1440");
      await page.mouse.move(0, 0);
      const found = await pairs(page);
      expect(found.length).toBeGreaterThan(0);
      const seams = await Promise.all(
        found.map(async ([left, right]) => ({
          label: `${await left.textContent()} | ${(await right.getAttribute("aria-label")) ?? (await right.textContent())}`,
          columns: await unowned(left, right),
        })),
      );
      for (const { label, columns } of seams) expect.soft(columns, label).toEqual([]);
    });
  });
}
