import type { Locator, Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { seedLayout } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { PHONE } from "./phone-key-bar.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const LINES = 5_000;

/**
 * An agent's transcript as a program prints one: 5,000 lines once, then it waits. No synchronized update, so the core
 * sends the attach replay as plain output — the shape #812 measures before herdr-core brackets its first paint. Each
 * line is 37 cells, so it fits the phone's width without wrapping and the line number stays on the row the view ends
 * on.
 */
const AGENT = String.raw`
awk -v n=${LINES} 'BEGIN {
  fill = ""
  for (k = 0; k < 26; k++) fill = fill "."
  for (i = 1; i <= n; i++) printf "\033[38;5;%dmline %05d %s\033[0m%s", 240 + i % 10, i, fill, (i < n ? "\r\n" : "")
}'
exec sleep 600
`;

/** The view's last screen row shows the transcript's end: the attach replay has finished painting. */
async function atLastLine(terminal: Locator): Promise<void> {
  await expect(terminal.locator(".term-row:not(.term-scrollback-row)").last()).toContainText(
    `line ${String(LINES).padStart(5, "0")}`,
    { timeout: 30_000 },
  );
}

/**
 * Samples the line number of the terminal screen's bottom row after every paint until `change` is done, 0 when no
 * screen row exists (a view just mounted, or between mounts). The screen's bottom row is what the view follows as
 * output arrives, so a replay painted in slices walks its history there. A sample is read after the frame's paint, as
 * the predictive-echo specs sample one, so it is what the person saw, not a midpoint of the frame. The terminal is
 * found by its address on each frame, as a layout change can mount it anew.
 */
async function sampleBottomWhile(page: Page, address: string, change: () => Promise<void>): Promise<number[]> {
  const samples = page.evaluate(
    (selector) =>
      new Promise<number[]>((resolve) => {
        const seen: number[] = [];
        const record = (): void => {
          const element = document.querySelector(selector);
          if (element !== null) {
            const rows = element.querySelectorAll(".term-row:not(.term-scrollback-row)");
            const last = rows[rows.length - 1];
            seen.push(Number(/line (\d{5})/.exec(last?.textContent ?? "")?.[1] ?? 0));
          } else seen.push(0);
          if (document.documentElement.hasAttribute("data-e2e-stop-first-paint")) {
            document.documentElement.removeAttribute("data-e2e-stop-first-paint");
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
    await page.evaluate(() => document.documentElement.setAttribute("data-e2e-stop-first-paint", ""));
  }
  return samples;
}

test.describe("on a phone", () => {
  test.use({ ...PHONE });

  test("a phone turned to landscape and back shows no frame with an earlier line at the bottom (#812)", async ({
    page,
  }) => {
    const dir = mkdtempSync(join(tmpdir(), "doriface-first-paint-"));
    const started: string[] = [];
    try {
      const script = join(dir, "agent.sh");
      writeFileSync(script, AGENT);
      const out = hcOn("host", ["run", "--bg", "--name", "first-paint-agent", "--", "bash", script]);
      const address = String((JSON.parse(out) as { address: string }).address);
      started.push(address);
      seedLayout([{ id: "tb-812", name: "agent", root: [{ pane: "p1", terminal: address }] }]);
      await page.goto("/");
      await page
        .getByRole("button", { name: /first-paint-agent/ })
        .first()
        .click();
      const terminal = page.locator(`[data-terminal="${address}"]`);
      await atLastLine(terminal);

      // Each crossing of the breakpoint mounts the view anew and attaches again, so the core's first paint replays the
      // last 2,000 lines: the bottom of the view must never walk through them (#812).
      const samples = await sampleBottomWhile(page, address, async () => {
        await page.setViewportSize({ width: 844, height: 390 });
        await atLastLine(terminal);
        await page.setViewportSize({ width: 390, height: 844 });
        await atLastLine(terminal);
      });

      const earlier = samples.filter((line) => line > 0 && line < LINES);
      expect(samples.length).toBeGreaterThan(0);
      expect(samples.filter((line) => line === LINES).length, "a frame showed the transcript's end").toBeGreaterThan(0);
      expect(earlier.slice(0, 10), `${earlier.length} of ${samples.length} frames ended on an earlier line`).toEqual(
        [],
      );
    } finally {
      for (const address of started) endAgent("host", address);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
