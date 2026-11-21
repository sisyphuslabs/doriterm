// #1387: on a phone a space row opens that space's own screen (its tabs, New tab in it), one history entry over the
// Spaces list, so Back walks back down: terminal -> space -> Spaces. A desktop's space row still only selects the space.
import { devices, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endAgent, startAgent } from "./agents.ts";
import { getCoreDoc } from "./core-doc.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { expect, test } from "./fixtures.ts";
import { LAYOUT_DOC, seedSpaces } from "./layout-doc.ts";

interface Seeded {
  readonly deploy: string;
  readonly tests: string;
  readonly plan: string;
}

/** website (deploy, tests) and infra (plan), each tab unnamed, so the rows read their terminals' names. */
function seed(): Seeded {
  const root = mkdtempSync(join(tmpdir(), "phone-space-"));
  const seeded = {
    deploy: startAgent("host", "deploy", "blocked", "website"),
    tests: startAgent("host", "tests", "done", "website"),
    plan: startAgent("host", "plan", "working", "infra"),
  };
  seedSpaces([
    {
      id: "spc-web",
      name: "website",
      folder: mkdtempSync(join(root, "website-")),
      tabs: [
        { id: "tb-deploy", name: "", terminal: seeded.deploy },
        { id: "tb-tests", name: "", terminal: seeded.tests },
      ],
    },
    {
      id: "spc-infra",
      name: "infra",
      folder: mkdtempSync(join(root, "infra-")),
      tabs: [{ id: "tb-plan", name: "", terminal: seeded.plan }],
    },
  ]);
  return seeded;
}

const end = (seeded: Seeded): void => Object.values(seeded).forEach((address) => endAgent("host", address));
const param = (page: Page, name: string): string | null => new URL(page.url()).searchParams.get(name);
const spaceRow = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^${name}\\b`) }).first();
const tabRows = (page: Page) => page.getByRole("region", { name: "Tabs" }).getByRole("button");
const spacesHeading = (page: Page) => page.getByRole("heading", { level: 1, name: "Spaces", exact: true });

/** How many tabs the saved layout gives the space named `name`. */
function savedTabs(name: string): number {
  const doc = getCoreDoc(LAYOUT_DOC) as { spaces?: { name?: string; tabs?: unknown[] }[] } | null;
  return (doc?.spaces ?? []).find((each) => each.name === name)?.tabs?.length ?? 0;
}

async function openWebsite(page: Page): Promise<void> {
  await page.goto("/?v=spaces");
  await expect(spaceRow(page, "website")).toBeVisible({ timeout: 20_000 });
  await spaceRow(page, "website").click();
  await expect(page.getByRole("heading", { level: 1, name: "website" })).toBeVisible({ timeout: 10_000 });
}

const PHONES = { "iPhone 14": devices["iPhone 14"], "Pixel 7": devices["Pixel 7"] };

for (const [phoneName, device] of Object.entries(PHONES)) {
  test.describe(`${phoneName} at 390x844`, () => {
    const { defaultBrowserType: _engine, ...metrics } = device;
    test.use({ ...metrics, viewport: { width: 390, height: 844 }, serviceWorkers: "block" });

    test("a space row opens the space's screen of tabs, and Back walks down terminal, space, Spaces", async ({
      page,
    }) => {
      const seeded = seed();
      try {
        await openWebsite(page);
        expect(param(page, "s"), "the space is in the address").not.toBeNull();
        expect(param(page, "t")).toBeNull();
        await expect(tabRows(page)).toHaveCount(2);
        await expect(tabRows(page).nth(0)).toContainText("deploy");
        await expect(tabRows(page).nth(1)).toContainText("tests");
        await expect(page.getByText("2 tabs · 1 needs you")).toBeVisible();
        const space = param(page, "s");

        await tabRows(page).filter({ hasText: "tests" }).click();
        await expect(page.locator(`[data-terminal="${seeded.tests}"]`)).toBeVisible({ timeout: 20_000 });
        expect(param(page, "t")).not.toBeNull();
        expect(param(page, "s"), "the terminal remembers the space it came from").toBe(space);

        await page.goBack();
        await expect(page.getByRole("heading", { level: 1, name: "website" })).toBeVisible();
        await expect(tabRows(page)).toHaveCount(2);
        expect(param(page, "t")).toBeNull();

        await page.goBack();
        await expect(spacesHeading(page)).toBeVisible();
        await expect.poll(() => param(page, "s")).toBeNull();
      } finally {
        end(seeded);
      }
    });

    test("the space screen's Back returns to Spaces, also on a cold open of the space's address", async ({ page }) => {
      const seeded = seed();
      try {
        await page.goto("/?v=spaces");
        await expect(spaceRow(page, "infra")).toBeVisible({ timeout: 20_000 });
        const entries = await page.evaluate(() => history.length);
        await spaceRow(page, "infra").click();
        await expect(page.getByRole("heading", { level: 1, name: "infra" })).toBeVisible({ timeout: 10_000 });
        expect(await page.evaluate(() => history.length), "opening a space adds one entry").toBe(entries + 1);
        await expect(tabRows(page)).toHaveCount(1);
        const url = page.url();

        await page.getByRole("button", { name: "Back to spaces" }).click();
        await expect(spacesHeading(page)).toBeVisible();
        await expect.poll(() => param(page, "s")).toBeNull();

        // Straight onto the space's own address on a page of its own, with nothing of the app behind it: a plain pop has no
        // entry of the app to land on, so only the guard's replace reaches the Spaces list.
        const cold = await page.context().newPage();
        await cold.goto(url);
        await expect(cold.getByRole("heading", { level: 1, name: "infra" })).toBeVisible({ timeout: 20_000 });
        await cold.getByRole("button", { name: "Back to spaces" }).click();
        await expect(spacesHeading(cold)).toBeVisible();
        await expect.poll(() => param(cold, "s")).toBeNull();
      } finally {
        end(seeded);
      }
    });

    test("a cold open of a space whose terminal list failed says why, with Try again, and Back still works", async ({
      page,
    }) => {
      const seeded = seed();
      try {
        await openWebsite(page);
        const url = page.url();
        // A page of its own whose very first answers fail: nothing of the first page's list carries over.
        const cold = await page.context().newPage();
        const link = await routeHcSocket(cold);
        const release = link.hold("terminal.list", "events.subscribe");
        await cold.goto(url);
        // Both first requests held before either fails: a feed that subscribed in the meantime would load the list (#1491).
        await expect
          .poll(() =>
            ["terminal.list", "events.subscribe"].every((method) =>
              link.sent().some((frame) => frame.includes(`"method":"${method}"`)),
            ),
          )
          .toBe(true);
        release(true);
        const notice = cold.getByRole("alert").filter({ hasText: "Could not load the space" });
        await expect(notice).toBeVisible({ timeout: 15_000 });
        await expect(cold.getByRole("button", { name: "Back to spaces" })).toBeVisible();
        link.hold();
        await notice.getByRole("button", { name: "Try again" }).click();
        await expect(cold.getByRole("heading", { level: 1, name: "website" })).toBeVisible({ timeout: 15_000 });
      } finally {
        end(seeded);
      }
    });

    test("no frame of the space screen's slide reaches past the screen's edge", async ({ page }) => {
      const seeded = seed();
      try {
        await page.goto("/?v=spaces");
        await expect(spaceRow(page, "website")).toBeVisible({ timeout: 20_000 });
        await expect.poll(() => page.evaluate(() => document.documentElement.hasAttribute("data-ready"))).toBe(true);
        // Every frame from the tap until the slide has settled: the page never grows wider than the screen.
        await page.evaluate(() => {
          const frames: { readonly width: number; readonly moving: boolean }[] = [];
          Reflect.set(window, "slideFrames", frames);
          const record = (): boolean => {
            // Only the arriving screen's own transform transition counts: a spinner or a button's colour is not the slide.
            const moving = document
              .getAnimations()
              .some(
                (motion) =>
                  motion.playState === "running" &&
                  motion instanceof CSSTransition &&
                  motion.transitionProperty === "transform" &&
                  motion.effect instanceof KeyframeEffect &&
                  motion.effect.target instanceof Element &&
                  motion.effect.target.classList.contains("motion-arrive"),
              );
            frames.push({ width: document.scrollingElement?.scrollWidth ?? 0, moving });
            return moving;
          };
          // The slide's start also takes a frame, so a loaded machine that paints few frames still measures one mid-slide;
          // its end (or cancel) closes the sampling, so a slide no frame saw moving fails the check below, not the wait.
          for (const type of ["transitionrun", "transitionend", "transitioncancel"]) {
            document.addEventListener(type, (event) => {
              const arriving =
                event instanceof TransitionEvent &&
                event.propertyName === "transform" &&
                event.target instanceof Element &&
                event.target.classList.contains("motion-arrive");
              if (!arriving) return;
              record();
              if (type !== "transitionrun") Reflect.set(window, "slideDone", true);
            });
          }
          const sample = (): void => {
            if (Reflect.get(window, "slideDone") === true) return;
            const moving = record();
            // Until the slide has run and settled; the poll below bounds the wait, however slowly frames come.
            if (frames.some((frame) => frame.moving) && !moving) Reflect.set(window, "slideDone", true);
            else requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        });
        await spaceRow(page, "website").click();
        await expect(page.getByRole("heading", { level: 1, name: "website" })).toBeVisible();
        await expect
          .poll(() => page.evaluate(() => Reflect.get(window, "slideDone") === true), { timeout: 15_000 })
          .toBe(true);
        const frames = await page.evaluate(
          () => Reflect.get(window, "slideFrames") as { readonly width: number; readonly moving: boolean }[],
        );
        expect(
          frames.some((frame) => frame.moving),
          "a sampled frame shows the slide moving",
        ).toBe(true);
        expect(Math.max(...frames.map((frame) => frame.width))).toBeLessThanOrEqual(390);
      } finally {
        end(seeded);
      }
    });

    test("a space closed while its screen is open gives way to the list, in place", async ({ page }) => {
      const seeded = seed();
      try {
        await openWebsite(page);
        const entries = await page.evaluate(() => history.length);
        // Another device closes website: only infra is left in the saved layout.
        seedSpaces([
          {
            id: "spc-infra",
            name: "infra",
            folder: mkdtempSync(join(tmpdir(), "phone-space-left-")),
            tabs: [{ id: "tb-plan", name: "", terminal: seeded.plan }],
          },
        ]);
        await expect(spacesHeading(page)).toBeVisible({ timeout: 15_000 });
        await expect.poll(() => param(page, "s")).toBeNull();
        expect(await page.evaluate(() => history.length), "the gone space is replaced, not stacked").toBe(entries);
      } finally {
        end(seeded);
      }
    });

    test("New tab in a space starts a tab in that space and opens it over the space's screen", async ({ page }) => {
      const seeded = seed();
      let made: string | null = null;
      try {
        await openWebsite(page);
        await page.getByRole("button", { name: "New tab in website" }).click();
        const opened = page.locator("[data-terminal]");
        await expect(opened).toHaveCount(1, { timeout: 20_000 });
        made = await opened.getAttribute("data-terminal");
        expect(Object.values(seeded)).not.toContain(made);
        expect(param(page, "t")).not.toBeNull();
        await expect.poll(() => savedTabs("website"), { timeout: 15_000 }).toBe(3);

        await page.goBack();
        await expect(page.getByRole("heading", { level: 1, name: "website" })).toBeVisible();
        await expect(tabRows(page)).toHaveCount(3);
      } finally {
        if (made !== null) endAgent("host", made);
        end(seeded);
      }
    });
  });
}

test("on a desktop a space row still only selects the space: no address, no history entry", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const seeded = seed();
  try {
    await page.goto("/");
    const row = page
      .getByRole("complementary", { name: "Workspace" })
      .getByRole("region", { name: "Spaces" })
      .getByRole("button", { name: /^website\b/ });
    await expect(row).toBeVisible({ timeout: 20_000 });
    const entries = await page.evaluate(() => history.length);
    await row.click();
    await expect(page.getByRole("tablist", { name: "Tabs" }).getByRole("tab")).toHaveCount(2);
    await expect(row).toHaveAttribute("aria-current", "true");
    expect(param(page, "s")).toBeNull();
    expect(await page.evaluate(() => history.length)).toBe(entries);
  } finally {
    end(seeded);
  }
});
