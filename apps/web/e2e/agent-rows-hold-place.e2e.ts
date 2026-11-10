import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { seedSpaces } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { rows } from "./sidebar-measure.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

endOwnTerminals();

const SPACE = "hold1949";
const SETTLE_MS = 15_000;

/** A shell in this test's space that reports a status only when told to, as an agent does when its turn changes. */
function startShell(name: string): string {
  const out = hcOn("host", ["run", "--bg", "--name", name, "--label", `space=${SPACE}`, "--", "env", "PS1=$ ", "sh"]);
  const started: unknown = JSON.parse(out);
  if (typeof started !== "object" || started === null || !("address" in started)) throw new Error(out);
  return String(started.address);
}

/** Types into the shell a report of `state` over OSC 7501, as an agent sends when its turn changes. */
function report(address: string, state: string): void {
  hcOn("host", ["send", "--force", address, `printf '\\033]7501;state=${state}\\033\\\\'`]);
}

const section = (page: Page, title: string) =>
  page.getByRole("complementary", { name: "Workspace" }).getByRole("region", { name: title, exact: true });

/** The status glyph on the sidebar row of `name`, whichever section the row is in. */
const glyphOf = (page: Page, name: string, status: string) =>
  rows(page.getByRole("complementary", { name: "Workspace" }))
    .filter({ hasText: name })
    .getByRole("img", { name: status, exact: true });

/** Records, every frame, how far down the page the row of `name` is drawn, until `stopSampling`. */
async function sampleTop(page: Page, name: string): Promise<void> {
  await page.evaluate((wanted) => {
    const tops: number[] = [];
    Object.assign(window, { __tops: tops, __sampling: true });
    const frame = (): void => {
      const row = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes(wanted));
      if (row !== undefined) tops.push(Math.round(row.getBoundingClientRect().top));
      if (Reflect.get(window, "__sampling") === true) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }, name);
}

async function stopSampling(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    Object.assign(window, { __sampling: false });
    const tops: unknown = Reflect.get(window, "__tops");
    return Array.isArray(tops) ? tops.map(Number) : [];
  });
}

test("an agent that idles between watch turns keeps its row in Working, so the rows below it hold still (#1949)", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const first = startShell("hold-a");
  const flapping = startShell("hold-b");
  const below = startShell("hold-c");
  seedSpaces([
    {
      folder: "",
      id: "spc-hold1949",
      name: SPACE,
      tabs: [
        { id: "tb-hold-a", name: "a", terminal: first },
        { id: "tb-hold-b", name: "b", terminal: flapping },
        { id: "tb-hold-c", name: "c", terminal: below },
      ],
    },
  ]);
  for (const address of [first, flapping, below]) report(address, "working");
  await page.goto("/");
  const working = section(page, "Working");
  await Promise.all(
    ["hold-a", "hold-b", "hold-c"].map((name) =>
      expect(rows(working).filter({ hasText: name })).toBeVisible({ timeout: 20_000 }),
    ),
  );

  await sampleTop(page, "hold-c");
  // A watch's turn ends, its agent idles, and the next firing wakes it again a few seconds later.
  report(flapping, "idle");
  await expect(glyphOf(page, "hold-b", "Idle")).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const tops: unknown = Reflect.get(window, "__tops");
    return Array.isArray(tops) && tops.length > 60;
  });
  report(flapping, "working");
  await expect(glyphOf(page, "hold-b", "Working")).toBeVisible({ timeout: 10_000 });
  const tops = await stopSampling(page);
  expect(tops.length).toBeGreaterThan(60);
  expect(new Set(tops)).toEqual(new Set([tops[0]]));

  // An idle turn that holds still moves the row, once the wait is over.
  report(flapping, "idle");
  await expect(rows(section(page, "Idle")).filter({ hasText: "hold-b" })).toBeVisible({ timeout: SETTLE_MS + 10_000 });
});
