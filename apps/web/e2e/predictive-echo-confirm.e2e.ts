import type { Locator, Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { type HcSocket, routeHcSocket } from "./hc-socket.ts";
import { PHONE, openPhoneTerminal } from "./phone-key-bar.ts";
import { shownPrefix, startRowSampler, stopRowSampler } from "./prediction-frames.ts";
import { painted, predictTyping, realCell } from "./prediction-probe.ts";
import { installPredictor } from "./prediction-stand-in.ts";

// Design review HIGH 4 (#1439): a predicted cell leaves the overlay when its echo is written, synchronously, inside the
// pacer's frame (mosh's Correct), but the renderer paints that echo only in a later frame. Every frame, as painted, must
// show each typed character either in the overlay or as the terminal's own glyph: never neither.

const RTT_MS = 300;

for (const device of ["desktop", "phone"] as const) {
  test.describe(device, () => {
    test.use(device === "phone" ? { ...PHONE, serviceWorkers: "block" } : {});

    async function open(page: Page): Promise<{ readonly terminal: Locator; readonly link: HcSocket }> {
      const link = await routeHcSocket(page);
      await installPredictor(page);
      let terminal: Locator;
      if (device === "phone") terminal = await openPhoneTerminal(page);
      else {
        await page.goto("/");
        terminal = await openNewTerminal(page);
      }
      link.delay(RTT_MS);
      await terminal.getByRole("textbox").focus();
      await predictTyping(page);
      return { terminal, link };
    }

    test("an echo written in the same frame as the next key's prediction never leaves its cell blank", async ({
      page,
    }) => {
      const { terminal, link } = await open(page);
      const release = link.holdFromHost("Q");
      await page.keyboard.type("Q");
      await expect(terminal.locator(".term-prediction-cell")).toHaveText(["Q"]);
      const cursor = await terminal.evaluate((element) => {
        const first = element.querySelector(".term-grid .term-row:not(.term-scrollback-row)")?.getBoundingClientRect();
        const cell = Number.parseFloat(getComputedStyle(element).getPropertyValue("--term-cell-width"));
        const box = element.querySelector(".term-prediction-cell")?.getBoundingClientRect();
        if (first === undefined || box === undefined) return null;
        return {
          row: Math.round((box.top - first.top) / first.height),
          col: Math.round((box.left - first.left) / cell),
        };
      });
      expect(cursor).not.toBeNull();
      console.log(`confirm ${device}: Q predicted at ${JSON.stringify(cursor)}`);
      // The next key is typed inside the task that hands the echo of Q to the pacer: its prediction is drawn in the
      // frame the pacer writes Q in, after that write.
      await page.evaluate(() => {
        Reflect.set(window, "__afterHostMessage", (data: unknown) => {
          if (!(data instanceof ArrayBuffer) || !new Uint8Array(data).includes(0x51)) return;
          Reflect.set(window, "__afterHostMessage", undefined);
          (Reflect.get(window, "__predictor") as { add(text: string, width: 1): void }).add("z", 1);
        });
      });
      await startRowSampler(terminal, cursor?.row ?? 0, cursor?.col ?? 0, 2);
      release();
      await expect.poll(() => realCell(page, cursor?.row ?? 0, cursor?.col ?? 0)).toBe("Q");
      await expect.poll(async () => (await terminal.evaluate(painted)).cells.map((cell) => cell.text)).toEqual(["z"]);
      const samples = await stopRowSampler(page);
      console.log(
        `confirm ${device}: ${samples.length} frames, distinct ${JSON.stringify([...new Set(samples.map((sample) => sample.row))])}`,
      );
      expect(samples.length).toBeGreaterThan(0);
      expect(samples.filter((sample) => sample.row[0] !== "Q")).toEqual([]);
    });

    // 60 ms: keys come faster than echoes, so several are out at once. 200 ms: each echo lands between two later keys,
    // the timing a loaded runner types at (#1434's CI failure).
    for (const cadence of [60, 200]) {
      test(`typing a line ahead of its echo at ${cadence} ms a key: every frame shows all that was shown before, and the overlay holds only the unconfirmed tail`, async ({
        page,
      }) => {
        const { terminal } = await open(page);
        const typed = "echo predict-ok";
        const start = await terminal.evaluate((element) => {
          const first = element
            .querySelector(".term-grid .term-row:not(.term-scrollback-row)")
            ?.getBoundingClientRect();
          const cursor = element.querySelector(".term-grid .term-cursor")?.getBoundingClientRect();
          const cell = Number.parseFloat(getComputedStyle(element).getPropertyValue("--term-cell-width"));
          if (first === undefined || cursor === undefined) return null;
          return {
            row: Math.round((cursor.top - first.top) / first.height),
            col: Math.round((cursor.left - first.left) / cell),
          };
        });
        expect(start).not.toBeNull();
        await startRowSampler(terminal, start?.row ?? 0, start?.col ?? 0, typed.length);
        await page.keyboard.type(typed, { delay: cadence });
        await expect.poll(() => realCell(page, start?.row ?? 0, (start?.col ?? 0) + typed.length - 1)).toBe("k");
        await expect(terminal.locator(".term-prediction-cell")).toHaveCount(0);
        const samples = await stopRowSampler(page);
        const prefixes = samples.map((sample) => shownPrefix(sample.row, typed));
        // Every frame: each overlay cell sits in the column its character is typed into (a cell one column off is never
        // confirmed and stays), and the overlay is a contiguous tail: the frame shows every typed character up to its end (a
        // blank cell reads as a typed space either side of the overlay, so it may also show the spaces typed after it).
        const misplaced = samples.flatMap((sample, index) =>
          sample.cells.some((cell) => typed[cell.col] !== cell.text)
            ? [`frame ${index}: ${JSON.stringify(sample.cells)}`]
            : [],
        );
        expect(misplaced).toEqual([]);
        const gaps = samples.flatMap((sample, index) => {
          const first = sample.cells[0]?.col;
          if (first === undefined) return [];
          const contiguous = sample.cells.every((cell, at) => cell.col === first + at);
          return contiguous && (prefixes[index] ?? 0) >= first + sample.cells.length
            ? []
            : [`frame ${index}: ${sample.row} ${JSON.stringify(sample.cells)}`];
        });
        expect(gaps).toEqual([]);
        const ahead = Math.max(...samples.map((sample) => sample.cells.length));
        console.log(`typing ${device} ${cadence}: at most ${ahead} cells ahead of the echo`);
        expect(ahead).toBeGreaterThan(0);
        expect(ahead).toBeLessThan(typed.length);
        console.log(
          `typing ${device} ${cadence}: ${samples.length} frames, shown prefix per frame ${JSON.stringify(prefixes)}`,
        );
        const lost = prefixes.flatMap((shown, index) =>
          index > 0 && shown < (prefixes[index - 1] ?? 0)
            ? [`frame ${index}: ${samples[index - 1]?.row} -> ${samples[index]?.row}`]
            : [],
        );
        expect(lost).toEqual([]);
        expect(prefixes.at(-1)).toBe(typed.length);
      });
    }
  });
}
