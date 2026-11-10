// Every working spinner on the page turns in step: the Agents rows, the space counts and any spinner mounted later are
// at the same point of the same 900 ms turn, and each draws at the same size (#1565).
import type { Page } from "@playwright/test";
import { agentRow, endAgent, startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";

test.use({ serviceWorkers: "block", viewport: { width: 1280, height: 800 } });

const agents = (page: Page) =>
  page.getByRole("complementary", { name: "Workspace" }).getByRole("region", { name: "Agents", exact: true });

/** Each visible spinner's point in its cycle (ms into the turn) and its drawn size. */
const spinners = (page: Page) =>
  page.locator('[data-slot="spinner"]:visible').evaluateAll((els) =>
    els.map((el) => {
      const [animation] = el.getAnimations();
      const box = el.getBoundingClientRect();
      const time = Number(animation?.currentTime ?? Number.NaN);
      // Where the shared clock stands: every spinner should be at the document timeline's own point in the turn.
      const clock = Number(document.timeline.currentTime) % 900;
      return { phase: time % 900, clock, width: Math.round(box.width), height: Math.round(box.height) };
    }),
  );

const apart = (a: number, b: number): number => Math.min(Math.abs(a - b), 900 - Math.abs(a - b));

test("working spinners mounted at different moments turn in step and draw at one size", async ({ page }) => {
  const started: string[] = [];
  try {
    started.push(startAgent("host", "spin-a", "working", "sp-spin-a"));
    await page.goto("/");
    await expect(agentRow(agents(page), "spin-a", false)).toBeVisible({ timeout: 20_000 });
    // A second and third agent start a while later, so their spinners mount after the first one's.
    await page.waitForFunction(
      () => document.timeline.currentTime !== null && Number(document.timeline.currentTime) > 0,
    );
    started.push(startAgent("host", "spin-b", "working", "sp-spin-b"));
    started.push(startAgent("host", "spin-c", "working", "sp-spin-c"));
    await expect(agentRow(agents(page), "spin-c", false)).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => (await spinners(page)).length).toBeGreaterThanOrEqual(4);

    const read = await spinners(page);
    const [first] = read;
    if (first === undefined) throw new Error("no spinner");
    for (const each of read) {
      expect(apart(each.phase, first.phase)).toBeLessThan(20);
      expect(apart(each.phase, each.clock)).toBeLessThan(20);
      expect([each.width, each.height]).toEqual([first.width, first.height]);
    }
  } finally {
    for (const address of started) endAgent("host", address);
  }
});
