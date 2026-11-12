import type { Locator, Page } from "@playwright/test";
import { endAgent, startShell } from "./agents.ts";
import { SHOTS } from "./capture-shots.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";

test.use({ serviceWorkers: "block" });

let shell = "";
test.beforeEach(() => {
  shell = startShell("host", "shell");
});
test.afterEach(() => {
  endAgent("host", shell);
});

/**
 * Every column between two neighbouring controls, on the line through both centres, that a pointer there would reach
 * neither of. Sampled every quarter of a CSS pixel: a high-density screen has three device pixels in one of these, so a
 * sliver narrower than a pixel is still a place a pointer lands on neither control. A control a pointer cannot reach at
 * its own centre is reported by what is there instead. Its NEIGHBOUR there, or any other control of its own role, is a COVER: the neighbour's hit layer takes the
 * tap meant for it, which is the very seam this proves, and fails in every case (#1912). Anything else there is
 * UNREACHABLE: in a list that scrolls (the Settings section tabs) that is a tab under the paging cue, not on screen to
 * tap, and only such a case skips it; anywhere else it fails too.
 */
const UNREACHABLE = "unreachable";
const unowned = async (left: Locator, right: Locator) =>
  left.evaluate(
    (a, b): (number | "unreachable" | "covered")[] => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const y = (Math.max(ra.top, rb.top) + Math.min(ra.bottom, rb.bottom)) / 2;
      const reached = (el: Element, box: DOMRect) =>
        el.contains(document.elementFromPoint(box.left + box.width / 2, y));
      // Taken by its neighbour, or by any other control of its own role (a tab two places over): a cover either way.
      const covered = (el: Element, box: DOMRect, neighbour: Element) => {
        const hit = document.elementFromPoint(box.left + box.width / 2, y);
        if (hit === null || el.contains(hit)) return false;
        if (neighbour.contains(hit)) return true;
        const role = el.getAttribute("role");
        const owner = role === null ? null : hit.closest(`[role="${role}"]`);
        return owner !== null && owner !== el;
      };
      if (covered(a, ra, b) || covered(b, rb, a)) return ["covered"];
      if (!reached(a, ra) || !reached(b, rb)) return ["unreachable"];
      const step = 0.25;
      const from = ra.right - 1;
      const to = rb.left + 1;
      const columns: number[] = [];
      for (let x = from; x <= to; x += step) {
        const hit = document.elementFromPoint(x, y);
        if (hit === null || !(a.contains(hit) || b.contains(hit))) columns.push(Math.round(x * 100) / 100);
      }
      return columns;
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
  /** The controls sit in a list that scrolls, so one can be off screen under its paging cue and has no seam to prove. */
  scrolls?: true;
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
    scrolls: true,
    pairs: (page) => neighbours(page.getByRole("dialog").getByRole("tab").filter({ visible: true })),
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

for (const { name, width, scrolls, pairs } of cases) {
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
      let measured = 0;
      for (const { label, columns } of seams) {
        if (scrolls === true && columns.includes(UNREACHABLE)) continue;
        measured += 1;
        expect.soft(columns, label).toEqual([]);
      }
      // A case whose every pair was skipped would pass having measured nothing.
      expect(measured, "pairs measured").toBeGreaterThan(0);
    });
  });
}
