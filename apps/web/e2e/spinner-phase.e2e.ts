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

// Turning reduced motion on or off while a spinner turns makes CSS swap its animation, with no React render; the new
// pulse or turn still starts on the shared clock rather than at the moment of the switch (#1555).
test("a spinner whose animation CSS recreates is put back in step", async ({ page }) => {
  const started: string[] = [];
  try {
    started.push(startAgent("host", "spin-motion", "working", "sp-spin-motion"));
    await page.goto("/");
    await expect(agentRow(agents(page), "spin-motion", false)).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => (await spinners(page)).length).toBeGreaterThanOrEqual(1);
    // The clock has moved well past zero, so a pulse begun at the switch is plainly out of step with it.
    await page.waitForFunction(() => Number(document.timeline.currentTime) > 2_000);

    await page.emulateMedia({ reducedMotion: "reduce" });
    const startTimes = () =>
      page
        .locator('[data-slot="spinner"]:visible')
        .evaluateAll((els) =>
          els.flatMap((el) => el.getAnimations().map((a) => `${(a as CSSAnimation).animationName}@${a.startTime}`)),
        );
    await expect.poll(startTimes).toContainEqual(expect.stringMatching(/^progress-opacity@/));
    await expect.poll(startTimes).toEqual(expect.arrayContaining(["progress-opacity@0"]));
    for (const each of await startTimes()) expect(each).toBe("progress-opacity@0");

    // Turning reduced motion back off swaps the pulse for a new turn, which starts on the shared clock too.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect.poll(startTimes).toContainEqual(expect.stringMatching(/^spin@/));
    await expect.poll(startTimes).toEqual(expect.arrayContaining(["spin@0"]));
    for (const each of await startTimes()) expect(each).toBe("spin@0");
  } finally {
    for (const address of started) endAgent("host", address);
  }
});
