import type { CDPSession } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { LONG_MACHINE, machineConnected, renameMachine, SEEDS, start, stop, type Seed } from "./sidebar-seed.ts";
import { rows as rowsOf, showAges } from "./sidebar-measure.ts";

/** Enough rows that a layout per row on refit shows up: the six seeds and sixty more. */
const EXTRA: readonly Seed[] = Array.from({ length: 60 }, (_, index) => ({
  name: `sb-many-${index}`,
  title: `OmO - Benchmark row ${index} with a fairly long title`,
  space: `many-${index % 7}`,
  ...(index % 2 === 0 ? { remote: true as const } : {}),
}));
const ROWS = SEEDS.length + EXTRA.length;
const MAX_LAYOUTS = 6;

test.use({ serviceWorkers: "block", viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

let addresses: readonly string[] = [];
let restore = (): void => {};
test.beforeAll(async () => {
  restore = renameMachine();
  await machineConnected(LONG_MACHINE);
  addresses = [...SEEDS, ...EXTRA].map((seed) => start(seed, LONG_MACHINE));
});
test.afterAll(() => {
  try {
    stop(addresses);
  } finally {
    restore();
  }
});

interface TraceEvent {
  readonly name: string;
  readonly ts: number;
}

/** Trace events while `act` runs: layouts and the user-timing marks around each row refit. */
async function trace(cdp: CDPSession, act: () => Promise<unknown>): Promise<readonly TraceEvent[]> {
  const events: TraceEvent[] = [];
  cdp.on("Tracing.dataCollected", ({ value }) => {
    for (const event of value) {
      const { name, ts } = event;
      if (typeof name === "string" && typeof ts === "number") events.push({ name, ts });
    }
  });
  const complete = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
  await cdp.send("Tracing.start", { categories: "devtools.timeline,blink.user_timing", transferMode: "ReportEvents" });
  await act();
  await cdp.send("Tracing.end");
  await complete;
  return events.toSorted((a, b) => a.ts - b.ts);
}

/**
 * The layouts a refit costs: every layout while a row observer's callback runs (each one forced by a read after a
 * write), plus the one after it that lays out what it wrote.
 */
function refitLayouts(events: readonly TraceEvent[]): { readonly refits: number; readonly layouts: number } {
  let refits = 0;
  let layouts = 0;
  let inside = false;
  let pendingWrite = false;
  for (const { name } of events) {
    if (name === "refit:start") {
      refits += 1;
      inside = true;
    } else if (name === "refit:end") {
      inside = false;
      pendingWrite = true;
    } else if (name === "Layout" && (inside || pendingWrite)) {
      layouts += 1;
      if (!inside) pendingWrite = false;
    }
  }
  return { refits, layouts };
}

test(`a sidebar width change refits ${ROWS} rows in at most ${MAX_LAYOUTS} layouts`, async ({ page }) => {
  // Marks the callbacks of the observers that watch sidebar rows, so the trace shows which layouts the refit causes.
  await page.addInitScript(() => {
    const Native = window.ResizeObserver;
    window.ResizeObserver = class extends Native {
      constructor(callback: ResizeObserverCallback) {
        super((entries, observer) => {
          const rows = entries.some(({ target }) => target.querySelector(":scope > [data-floor]") !== null);
          if (rows) performance.mark("refit:start");
          callback(entries, observer);
          if (rows) performance.mark("refit:end");
        });
      }
    };
  });
  await showAges(page);
  await page.goto("/");
  // Other specs on the same host may leave idle rows of their own, so at least this spec's rows.
  const rows = rowsOf(page.getByRole("region", { name: "Idle" }));
  await expect.poll(() => rows.count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(ROWS);
  const floors = () =>
    rows.evaluateAll((buttons) =>
      buttons.map((row) =>
        [...row.querySelectorAll<HTMLElement>(":scope > [data-floor]")].map((part) => part.style.minWidth).join(),
      ),
    );
  const before = await floors();
  const cdp = await page.context().newCDPSession(page);
  const events = await trace(cdp, () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          document.documentElement.style.setProperty("--sidebar-width", "15.5rem");
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        }),
    ),
  );
  const after = await floors();
  const { refits, layouts } = refitLayouts(events);
  expect(after.filter((floor, index) => floor !== before[index]).length, "rows were refitted").toBeGreaterThan(0);
  expect(refits, "the rows' observer reported the width change").toBeGreaterThan(0);
  expect(layouts, `layouts for refitting ${ROWS} rows`).toBeLessThanOrEqual(MAX_LAYOUTS);
});
