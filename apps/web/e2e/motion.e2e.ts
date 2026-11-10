import type { Page } from "@playwright/test";
import { agentRow, endAgent, startShell } from "./agents.ts";
import { expect, openNewTerminal, test, pressNewTab } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { MACHINE_NAME } from "./machine.ts";
import { hcOn } from "./machine-switch.ts";
import { domOrder, dragPast, openFour, tabOf, tabs } from "./tab-strip.ts";

test.use({ serviceWorkers: "block" });

const SIDEBAR = 'aside[aria-label="Workspace"]';

/** Collects every transition an arrival region starts, as "tag:property". */
const listen = () => {
  const seen: string[] = [];
  Object.defineProperty(window, "__arrivals", { value: seen });
  document.addEventListener(
    "transitionstart",
    (event) => {
      if (event.target instanceof Element && event.target.classList.contains("motion-arrive")) {
        seen.push(`${event.target.tagName.toLowerCase()}:${event.propertyName}`);
      }
    },
    true,
  );
};
/** Records arrivals from the page's very first script, so a load-time one cannot slip past. */
const recordArrivals = (page: Page) => page.addInitScript(listen);
/** Records arrivals from now on in the current document, which in-app navigation keeps. */
const watchArrivals = (page: Page) => page.evaluate(listen);
/** Every terminal address the e2e core lists: this machine's (`t3`) and the added machine's (`build-box/t2`). */
const listedOnCore = (): string[] => {
  const listed: unknown = JSON.parse(hcOn("host", ["ls", "--json"]));
  const terminals = typeof listed === "object" && listed !== null ? Reflect.get(listed, "terminals") : undefined;
  if (!Array.isArray(terminals)) throw new Error("hc ls printed no terminal list");
  return terminals.map((terminal: unknown) =>
    String(typeof terminal === "object" && terminal !== null ? Reflect.get(terminal, "address") : ""),
  );
};
/** Ends every terminal started since `before` on the core that runs it (one worker, so only this test's). */
const endStartedSince = (before: ReadonlySet<string>) => {
  const remote = `${MACHINE_NAME}/`;
  for (const address of listedOnCore()) {
    if (before.has(address)) continue;
    if (address.startsWith(remote)) endAgent("machine", address.slice(remote.length));
    else endAgent("host", address);
  }
};
/** An arrival starts when its region mounts, before it is visible; two frames let transitionstart dispatch. */
const twoFrames = (page: Page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))),
  );
const arrivals = (page: Page) =>
  page.evaluate(() => {
    const seen: unknown = Reflect.get(window, "__arrivals");
    return Array.isArray(seen) ? seen.filter((entry): entry is string => typeof entry === "string").toSorted() : [];
  });

/**
 * Watches an element's opacity and transform every frame from now until it has appeared, run an animation and has
 * none left running, so the last frame is its resting state; `ceiling` ms bounds the wait if it never settles.
 */
const sample = (page: Page, selector: string, ceiling = 15_000) =>
  page.evaluate(
    ([sel, limit]) =>
      new Promise<{ opacity: number; transform: string; duration: number }[]>((resolve) => {
        // `duration` is the longest running animation's, in ms (0 when none runs).
        const frames: { opacity: number; transform: string; duration: number }[] = [];
        let animated = false;
        const start = performance.now();
        const step = () => {
          const el = document.querySelector(sel);
          if (el !== null) {
            const style = getComputedStyle(el);
            const animations = el.getAnimations();
            const durations = animations.map((animation) =>
              Number(animation.effect?.getComputedTiming().duration ?? 0),
            );
            frames.push({
              opacity: Number(style.opacity),
              transform: style.transform,
              duration: Math.max(0, ...durations),
            });
            const running = animations.length > 0;
            animated ||= running;
            if (animated && !running) return resolve(frames);
          }
          if (performance.now() - start > limit) return resolve(frames);
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    [selector, ceiling] as const,
  );

// Each test ends every terminal it started (the New tab clicks, openNewTerminal, the added machine's shell), even when it
// fails, so no later spec has to exit them: phone-empty ends every listed shell inside its own time budget.
let started: ReadonlySet<string> = new Set();
test.beforeEach(() => {
  started = new Set(listedOnCore());
});
test.afterEach(() => endStartedSince(started));

test("the first screen does not animate in: nothing arrives on load, and a later new tab does", async ({ page }) => {
  await page.goto("/");
  await openNewTerminal(page);
  await recordArrivals(page);
  await page.reload();
  await expect(page.locator(SIDEBAR)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("tab").first()).toBeVisible();
  await expect.poll(() => page.locator(":root").getAttribute("data-ready")).toBe("");
  await twoFrames(page);
  expect(await arrivals(page)).toEqual([]);
  await pressNewTab(page.getByRole("button", { name: "New tab", exact: true }));
  await expect.poll(() => arrivals(page)).toContain("div:opacity");
});

test("a kept tab on an added machine does not arrive late on the way back from Settings while machine.list is slow", async ({
  page,
}) => {
  const faraway = startShell("machine", "faraway");
  const nearby = startShell("host", "nearby");
  const socket = await routeHcSocket(page);
  await page.goto("/");
  // A local tab beside the remote one: the local tab shows at once, the remote one only once machine.list names its
  // machine (its tab is kept by machine id). Each is opened from its own agent row: New tab opens on the focused pane's
  // machine, and the tab the workspace opens on its own at load can be the remote one, so it cannot make the local tab.
  await agentRow(page, "nearby", false).click({ timeout: 20_000 });
  // A tab reads its number, as herdr-app's: each is found by the terminal its panel shows, then kept by its panel id.
  const localTab = await tabOf(page, nearby);
  await expect(localTab).toBeVisible({ timeout: 20_000 });
  await agentRow(page, "faraway", true).click({ timeout: 20_000 });
  const remoteTab = await tabOf(page, `${MACHINE_NAME}/${faraway}`);
  await expect(remoteTab).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.locator(":root").getAttribute("data-ready")).toBe("");
  await watchArrivals(page);
  const release = socket.hold("machine.list");
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "This device", level: 2 })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("contentinfo").getByText(/^\d+ terminals?\b/)).toBeVisible({ timeout: 20_000 });
  await twoFrames(page);
  // Settings keeps the workspace, so the strip never lost the tab: coming back shows it as it was, with nothing left to
  // arrive from a list that had to be asked for again while machine.list was held.
  await expect(remoteTab).toBeVisible();
  release();
  await expect(remoteTab).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.locator(":root").getAttribute("data-ready")).toBe("");
  await twoFrames(page);
  expect(await arrivals(page)).toEqual([]);
  // New tab opens on the focused pane's machine: focus the local terminal, so the control opens nothing on the added
  // machine. Its tab is in this machine's space, which the strip does not show beside the remote one (#404).
  await agentRow(page, "nearby", false).click();
  await expect(localTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-focused="true"] [data-terminal]')).toHaveAttribute("data-terminal", /^[^/]+$/);
  await pressNewTab(page.getByRole("button", { name: "New tab", exact: true }));
  await expect.poll(() => arrivals(page)).toContain("div:opacity");
});

test("coming back from Settings is not an arrival: the workspace returns without animating", async ({ page }) => {
  await page.goto("/");
  await openNewTerminal(page);
  await expect.poll(() => page.locator(":root").getAttribute("data-ready")).toBe("");
  await recordArrivals(page);
  await page.reload();
  await expect.poll(() => page.locator(":root").getAttribute("data-ready")).toBe("");
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "This device", level: 2 })).toBeVisible();
  await page.goBack();
  await expect(page.locator(SIDEBAR)).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.locator(":root").getAttribute("data-ready")).toBe("");
  await twoFrames(page);
  expect(await arrivals(page)).toEqual([]);
  await pressNewTab(page.getByRole("button", { name: "New tab", exact: true }));
  await expect.poll(() => arrivals(page)).toContain("div:opacity");
});

test("moving a tab is not an arrival: a drag, a keyboard move and a menu move start no arrival on any tab", async ({
  page,
}) => {
  await openFour(page);
  await expect.poll(() => page.locator(":root").getAttribute("data-ready")).toBe("");
  await watchArrivals(page);
  // Each move has to change the strip's DOM order: that DOM move is what could restart a tab's arrival.
  const moved = async (move: () => Promise<void>) => {
    const before = await domOrder(page);
    await move();
    await expect.poll(() => domOrder(page)).not.toEqual(before);
  };
  await moved(() => dragPast(page, tabs(page).nth(0), tabs(page).nth(2)));
  await moved(async () => {
    const mac = await page.evaluate(() => navigator.platform.startsWith("Mac"));
    await tabs(page).nth(0).focus();
    await page.keyboard.press(mac ? "Meta+Shift+ArrowRight" : "Control+Alt+Shift+PageDown");
  });
  await moved(async () => {
    await tabs(page).nth(3).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move tab left" }).click();
  });
  await twoFrames(page);
  // A drag slides the neighbours (`translate`); an arrival is the opacity and transform from @starting-style.
  expect((await arrivals(page)).filter((entry) => !entry.endsWith(":translate"))).toEqual([]);
  await pressNewTab(page.getByRole("button", { name: "New tab", exact: true }));
  await expect.poll(() => arrivals(page)).toContain("div:opacity");
});

test("showing the sidebar fades it in without moving it", async ({ page }) => {
  await page.goto("/");
  await openNewTerminal(page);
  await expect.poll(() => page.locator(":root").getAttribute("data-ready")).toBe("");
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  const frames = sample(page, SIDEBAR);
  await page.getByRole("button", { name: "Show sidebar" }).click();
  const seen = await frames;
  expect(Math.min(...seen.map((frame) => frame.opacity))).toBeLessThan(0.5);
  // At rest after the transition ended (the sampler waits for it): a computed opacity can land a hair under 1.
  expect(seen.at(-1)?.opacity).toBeCloseTo(1, 2);
  expect(seen.every((frame) => frame.transform === "none")).toBe(true);
});

test("a new tab scales and fades in, and settles at rest", async ({ page }) => {
  await page.goto("/");
  await openNewTerminal(page);
  await expect.poll(() => page.locator(":root").getAttribute("data-ready")).toBe("");
  const count = await page.getByRole("tab").count();
  // Unpinned tabs sit in the strip's scrolling group, pinned ones (#1561) in a group before it; this strip has no pins.
  const newest = `[role="tablist"] [data-tab-scroll] > div:nth-of-type(${count + 1})`;
  const frames = sample(page, newest);
  await pressNewTab(page.getByRole("button", { name: "New tab", exact: true }));
  const seen = await frames;
  expect(seen.length).toBeGreaterThan(0);
  expect(Math.min(...seen.map((frame) => frame.opacity))).toBeLessThan(0.5);
  expect(seen.some((frame) => frame.transform !== "none")).toBe(true);
  // A tab arrives on the micro duration (120 ms), not the standard one.
  expect([...new Set(seen.flatMap((frame) => (frame.duration > 0 ? [frame.duration] : [])))]).toEqual([120]);
  expect(seen.at(-1)?.opacity).toBeCloseTo(1, 2);
  expect(seen.at(-1)?.transform).toBe("none");
});

test("under reduced motion a new tab only fades: no frame is transformed", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await openNewTerminal(page);
  await expect.poll(() => page.locator(":root").getAttribute("data-ready")).toBe("");
  const count = await page.getByRole("tab").count();
  const frames = sample(page, `[role="tablist"] [data-tab-scroll] > div:nth-of-type(${count + 1})`);
  await pressNewTab(page.getByRole("button", { name: "New tab", exact: true }));
  const seen = await frames;
  expect(Math.min(...seen.map((frame) => frame.opacity))).toBeLessThan(0.5);
  expect(seen.every((frame) => frame.transform === "none")).toBe(true);
});
