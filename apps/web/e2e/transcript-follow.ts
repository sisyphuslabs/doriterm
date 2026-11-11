import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { SYNC_HOLD_MS, type SyncUpdate } from "./synchronized-updates.ts";

export interface Sample {
  readonly away: number;
  /** The newest transcript line the screen shows (the rest of a reflowed line shows none); 0 for none. */
  readonly newest: number;
  /**
   * The oldest transcript line inside the scroll element's visible box, scrollback rows included; 0 for none. A view
   * that jumps into the history shows old lines here, while the screen's rows (`newest`) stay mounted wherever it is.
   */
  readonly top: number;
  /** Rows on the screen, the view's height in lines. */
  readonly screen: number;
  /**
   * Rows inside the scroll element's visible box, scrollback rows included: more than `screen` when the sample is read
   * after a layout change and before the grid is fitted to it.
   */
  readonly inView: number;
  /** When it was read, by the page's `performance.now()`, the clock `watchSynchronizedUpdates` records on. */
  readonly t: number;
}

/**
 * Samples the view after every paint until `change` is done: how far it is from the bottom, and the newest line its
 * screen shows. Each sample is what the user saw: read after the frame's ResizeObserver callbacks and paint, not in its
 * animation-frame callback, before a layout change has been fitted. The terminal is found by its address on each frame, as a layout
 * change can mount it anew; a frame without it records nothing.
 */
export async function sampleWhile(page: Page, address: string, change: () => Promise<void>): Promise<Sample[]> {
  const samples = page.evaluate(
    (selector) =>
      new Promise<Sample[]>((resolve) => {
        const seen: Sample[] = [];
        const record = (): void => {
          const element = document.querySelector(selector);
          if (element !== null) {
            const rows = [...element.querySelectorAll(".term-row:not(.term-scrollback-row)")];
            // The visible box is the content box: both edges start below the border.
            const edge = element.getBoundingClientRect().top + element.clientTop;
            const bottom = edge + element.clientHeight;
            const inView = [...element.querySelectorAll(".term-row")].filter((row) => {
              const rect = row.getBoundingClientRect();
              return rect.bottom > edge + 1 && rect.top < bottom - 1;
            });
            const visible = inView
              .map((row) => Number(/row (\d{5})/.exec(row.textContent ?? "")?.[1] ?? 0))
              .filter((number) => number > 0);
            seen.push({
              away: element.scrollHeight - element.clientHeight - element.scrollTop,
              newest: Math.max(0, ...rows.map((row) => Number(/row (\d{5})/.exec(row.textContent ?? "")?.[1] ?? 0))),
              top: visible.length === 0 ? 0 : Math.min(...visible),
              screen: rows.length,
              inView: inView.length,
              t: performance.now(),
            });
          }
          if (document.documentElement.hasAttribute("data-e2e-stop-sampling")) {
            document.documentElement.removeAttribute("data-e2e-stop-sampling");
            resolve(seen);
          } else afterPaint();
        };
        // A message posted in a frame's callback is delivered once that frame is painted.
        const channel = new MessageChannel();
        channel.port1.addEventListener("message", record);
        channel.port1.start();
        const afterPaint = (): void => void requestAnimationFrame(() => channel.port2.postMessage(null));
        record();
      }),
    `[data-terminal="${address}"]`,
  );
  try {
    await change();
  } finally {
    // A change that fails still stops the sampler, so its own error is reported instead of a timeout here.
    await page.evaluate(() => document.documentElement.setAttribute("data-e2e-stop-sampling", ""));
  }
  return samples;
}

const followsEnd = (sample: Sample, last: number, atBottom: boolean): boolean =>
  sample.newest === last &&
  sample.top > last - 2 * Math.max(sample.screen, sample.inView) &&
  (!atBottom || sample.away < 5);

/**
 * Every frame painted inside wterm's synchronized-update hold showed the transcript's end, and none scrolled back through
 * it: the lines in view are all within two views of the end, a view being the screen's rows or the rows the visible box
 * holds, whichever is more. `atBottom` also requires each frame at the scroll element's very bottom; a layout change that
 * React commits in its own task can be read after it lands and before the frame's ResizeObserver fits the grid to it, a
 * state the browser never paints, so that is checked only where no such change happens.
 *
 * That is the product's contract (#757, #853): a redraw is drawn whole when its synchronized update closes within the
 * hold. A page too starved to take an update in {@link SYNC_HOLD_MS} (it hands the stream's credit back slowly, #2011)
 * gets it painted as it comes, by design: past the hold the terminal paints anyway and the rest is paced. The page
 * cannot see when its pacer's backlog of such an update drains, so from the first moment a hold could have run out
 * (an update open {@link SYNC_HOLD_MS} after it reached the page; the hold starts no earlier) each frame is held only to
 * what a paced redraw still guarantees: at the bottom, and no line in view older than two views before the newest one
 * drawn. How many frames that covered is reported. Every frame before it is held to the end, so a view that leaves the
 * end inside the hold still fails here, and one that scrolls back through its history fails anywhere.
 */
export function expectFollowed(
  samples: readonly Sample[],
  updates: readonly SyncUpdate[],
  last: number,
  { atBottom = true } = {},
): void {
  // Only the updates still open while the frames were sampled; one that closed before has no say in them.
  const from = samples[0]?.t ?? Infinity;
  const holdRanOut = Math.min(
    ...updates
      .filter((update) => (update.close ?? Infinity) >= from)
      .filter((update) => (update.close ?? Infinity) - update.open >= SYNC_HOLD_MS)
      .map((update) => update.open + SYNC_HOLD_MS),
  );
  const inside = samples.filter((sample) => sample.t < holdRanOut);
  const past = samples.filter((sample) => sample.t >= holdRanOut);
  if (past.length > 0)
    test.info().annotations.push({
      type: "synchronized-hold-overrun",
      description: `an update outlasted the ${SYNC_HOLD_MS} ms hold; ${past.length} of ${samples.length} frames from then on were held to a paced redraw's guarantees only (#2011)`,
    });
  const off = inside.filter((sample) => !followsEnd(sample, last, atBottom));
  const lost = past.filter(
    (sample) =>
      sample.top <= sample.newest - 2 * Math.max(sample.screen, sample.inView) || (atBottom && sample.away >= 5),
  );
  expect(inside.length).toBeGreaterThan(0);
  expect(off.slice(0, 5), `${off.length} of ${inside.length} frames inside the hold left the transcript's end`).toEqual(
    [],
  );
  expect(
    lost.slice(0, 5),
    `${lost.length} of ${past.length} frames past the hold left the bottom or scrolled back`,
  ).toEqual([]);
}
