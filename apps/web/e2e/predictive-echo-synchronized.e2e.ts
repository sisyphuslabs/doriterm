import type { Locator, Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { PHONE, openPhoneTerminal } from "./phone-key-bar.ts";
import { type RowSample, startRowSampler, stopRowSampler } from "./prediction-frames.ts";
import { predictTyping } from "./prediction-probe.ts";
import { installPredictor } from "./prediction-stand-in.ts";

// Design review HIGH 4 (#1439), the synchronized-update case: a main-screen program that redraws its input line inside
// a synchronized update (DECSET 2026) echoes a key into the terminal while wterm holds the paint until the update ends.
// The overlay must keep the predicted cell until that paint lands: releasing it on the next frame blanks the cell for as
// long as the update stays open.

/** A program that echoes one key inside a synchronized update held `holdMs`, or never closed when `close` is false. */
function echoProgram(name: string, holdMs: number, close: boolean): string {
  const path = join(tmpdir(), `doriterm-${name}-${process.pid}.sh`);
  const end = close ? String.raw`printf '\033[?2026l'` : ":";
  writeFileSync(
    path,
    [
      "stty -echo -icanon min 1",
      "printf 'ready> '",
      "key=$(dd bs=1 count=1 2>/dev/null)",
      String.raw`printf '\033[?2026h%s' "$key"`,
      `sleep ${holdMs / 1000}`,
      end,
      "sleep 30",
    ].join("\n"),
  );
  return path;
}

/** Each frame after the core first held `key`: the core, the grid and the frame as painted (overlay over grid). */
function after(samples: readonly RowSample[], key: string): RowSample[] {
  const first = samples.findIndex((sample) => sample.core[0] === key);
  return first < 0 ? [] : samples.slice(first);
}

for (const device of ["desktop", "phone"] as const) {
  test.describe(device, () => {
    test.use(device === "phone" ? { ...PHONE, serviceWorkers: "block" } : {});

    async function run(page: Page, program: string): Promise<{ terminal: Locator; samples: RowSample[] }> {
      const link = await routeHcSocket(page);
      await installPredictor(page);
      let terminal: Locator;
      if (device === "phone") terminal = await openPhoneTerminal(page);
      else {
        await page.goto("/");
        terminal = await openNewTerminal(page);
      }
      await terminal.getByRole("textbox").focus();
      await page.keyboard.type(`bash ${program}`);
      await page.keyboard.press("Enter");
      await expect(terminal.locator(".term-row").filter({ hasText: /^ready> *$/ })).toHaveCount(1, { timeout: 15_000 });
      const start = await terminal.evaluate((element) => {
        const first = element.querySelector(".term-grid .term-row:not(.term-scrollback-row)")?.getBoundingClientRect();
        const cursor = element.querySelector(".term-grid .term-cursor")?.getBoundingClientRect();
        const cell = Number.parseFloat(getComputedStyle(element).getPropertyValue("--term-cell-width"));
        if (first === undefined || cursor === undefined) return { row: 0, col: 0 };
        return {
          row: Math.round((cursor.top - first.top) / first.height),
          col: Math.round((cursor.left - first.left) / cell),
        };
      });
      link.delay(300);
      await predictTyping(page);
      await startRowSampler(terminal, start.row, start.col, 1);
      await page.keyboard.type("Q");
      await expect(terminal.locator(".term-prediction-cell")).toHaveText(["Q"]);
      await expect(terminal.locator(".term-row").filter({ hasText: /^ready> Q *$/ })).toHaveCount(1, { timeout: 5000 });
      await expect(terminal.locator(".term-prediction-cell")).toHaveCount(0);
      return { terminal, samples: await stopRowSampler(page) };
    }

    test("an echo inside a synchronized update stays drawn until the update's paint lands", async ({ page }) => {
      const { samples } = await run(page, echoProgram("sync-echo", 500, true));
      const held = after(samples, "Q");
      const unpainted = held.filter((sample) => sample.grid[0] !== "Q");
      const blank = held.filter((sample) => sample.row[0] !== "Q");
      console.log(
        `sync ${device}: ${held.length} frames after the echo, ${unpainted.length} with it unpainted, ${blank.length} blank`,
      );
      // The held path ran: the core held the echo for frames the renderer did not paint it in.
      expect(unpainted.length).toBeGreaterThan(5);
      expect(blank.map((sample) => `${sample.at.toFixed(0)} grid=${JSON.stringify(sample.grid)}`)).toEqual([]);
    });

    test("an echo in a synchronized update the program never closes is still drawn every frame until wterm paints it", async ({
      page,
    }) => {
      const { samples } = await run(page, echoProgram("sync-open", 3000, false));
      const held = after(samples, "Q");
      const blank = held.filter((sample) => sample.row[0] !== "Q");
      const painted = held.find((sample) => sample.grid[0] === "Q");
      const waited = (painted?.at ?? Number.NaN) - (held[0]?.at ?? Number.NaN);
      console.log(`sync never closed ${device}: painted ${waited.toFixed(0)} ms after the echo, ${blank.length} blank`);
      // wterm's own fallback paints a held update 1000 ms after it opened; until then the overlay is all that shows Q.
      expect(waited).toBeGreaterThan(800);
      expect(blank.map((sample) => `${sample.at.toFixed(0)} grid=${JSON.stringify(sample.grid)}`)).toEqual([]);
    });
  });
}
