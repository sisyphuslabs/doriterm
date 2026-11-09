import type { Locator, Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { type HcSocket, routeHcSocket } from "./hc-socket.ts";
import { PHONE, openPhoneTerminal } from "./phone-key-bar.ts";
import { predict, untilShellReads } from "./prediction-probe.ts";
import { installPredictor } from "./prediction-stand-in.ts";

// A drawn prediction is underlined only while its predictor is flagging, as mosh does (#1439 HIGH 2). The real
// predictor flags while its echo SRTT is above 160 ms (cleared at 100 ms or less) or on a glitch; those thresholds are
// unit-tested (prediction-display.test.ts). Here the overlay and stylesheet are checked both ways with a stand-in whose
// flagging the spec switches, so the plain half does not depend on how fast a loaded runner echoes; and the real
// predictor at a relay's 300 ms, which only load can raise, draws its cells underlined.

const prompt = (terminal: Locator) =>
  terminal.locator(".term-row:not(.term-scrollback-row)").filter({ hasText: /^\$ / });

const KEYS = "abcdefghij";

/** The echo round trips the predictor measured, in order: keypress to the echo on screen. */
const roundTrips = (page: Page): Promise<number[]> =>
  page.evaluate(() =>
    ((Reflect.get(window, "__dorifacePredictLog") as { kind: string; latencyMs?: number }[] | undefined) ?? [])
      .filter((event) => event.kind === "confirmed")
      .map((event) => Math.round(event.latencyMs ?? 0)),
  );

/**
 * mosh's flagging replayed over the predictor's own samples (prediction-display.ts): SRTT with RFC 6298's gains, set
 * above 160 ms, cleared at 100 ms or less, and set before the first sample. The routed socket and a loaded runner add
 * their own, uneven time to every echo, so a spec reads what the predictor measured rather than assume the delay it
 * injected.
 */
function measured(samples: readonly number[]): { readonly srtt: number; readonly flagging: boolean } {
  let srtt = Number.POSITIVE_INFINITY;
  let flagging = true;
  for (const sample of samples) {
    srtt = srtt === Number.POSITIVE_INFINITY ? sample : 0.875 * srtt + 0.125 * sample;
    if (srtt > 160) flagging = true;
    else if (srtt <= 100) flagging = false;
  }
  return { srtt, flagging };
}

const described = async (page: Page): Promise<string> => {
  const samples = await roundTrips(page);
  const { srtt, flagging } = measured(samples);
  return `echo round trips (ms): ${samples.join(" ")}; SRTT ${Math.round(srtt)}, flagging ${String(flagging)}`;
};

async function echoed(page: Page, terminal: Locator, line: string): Promise<void> {
  await page.keyboard.type(line.slice(-1));
  await expect(prompt(terminal).filter({ hasText: `$ ${line}` })).toHaveCount(1, { timeout: 15_000 });
}

/** Echoes keys over a link holding host frames `delay` ms. Returns the line typed. */
async function settle(page: Page, terminal: Locator, link: HcSocket, line: string, delay: number): Promise<string> {
  link.delay(delay);
  let typed = line;
  for (const key of KEYS) {
    typed += key;
    // oxlint-disable-next-line no-await-in-loop -- each key's echo is a sample the next one builds on
    await echoed(page, terminal, typed);
  }
  return typed;
}

/** The computed text-decoration-line of a key's predicted cell, read while the host's echo of it is held. */
async function drawnDecoration(page: Page, terminal: Locator, link: HcSocket, line: string): Promise<string> {
  const release = link.holdFromHost("");
  await page.keyboard.type("z");
  const cell = terminal.locator(".term-prediction-cell");
  await expect(cell).toHaveText(["z"]);
  const decoration = await cell.evaluate((element) => getComputedStyle(element).textDecorationLine);
  release();
  await expect(prompt(terminal).filter({ hasText: `$ ${line}z` })).toHaveCount(1, { timeout: 15_000 });
  await expect(cell).toHaveCount(0, { timeout: 15_000 });
  return decoration;
}

/** Switches the stand-in predictor's flagging; the overlay repaints from its announcement. */
const flag = (page: Page, on: boolean) =>
  page.evaluate((value) => (Reflect.get(window, "__predictor") as { flagging(on: boolean): void }).flagging(value), on);

const decorationOf = (cell: Locator) => cell.evaluate((element) => getComputedStyle(element).textDecorationLine);

for (const device of ["desktop", "phone"] as const) {
  test.describe(device, () => {
    test.use(device === "phone" ? { ...PHONE, serviceWorkers: "block" } : { serviceWorkers: "block" });

    /**
     * A terminal at its prompt, predictions always drawn (by the stand-in when `standIn`), its host frames routed
     * through the spec.
     */
    async function open(page: Page, standIn = false): Promise<{ readonly terminal: Locator; readonly link: HcSocket }> {
      const link = await routeHcSocket(page);
      if (standIn) await installPredictor(page);
      else await page.addInitScript(() => localStorage.setItem("doriface.terminal.predict-typing", "always"));
      let terminal: Locator;
      if (device === "phone") terminal = await openPhoneTerminal(page);
      else {
        await page.goto("/");
        terminal = await openNewTerminal(page);
      }
      await terminal.getByRole("textbox").focus();
      await untilShellReads(page, terminal);
      return { terminal, link };
    }

    test("a predicted cell is drawn with no underline while its predictor is not flagging, and underlined while it is", async ({
      page,
    }) => {
      const { terminal, link } = await open(page, true);
      const release = link.holdFromHost("");
      await flag(page, false);
      expect((await predict(page, "z")).frames).toBeGreaterThan(0);
      const cell = terminal.locator(".term-prediction-cell");
      await expect(cell).toHaveText(["z"]);
      expect(await decorationOf(cell)).toBe("none");
      // The same drawn cell follows each switch: underlined once its predictor flags, plain again once it stops.
      await flag(page, true);
      await expect.poll(() => decorationOf(cell)).toBe("underline");
      await flag(page, false);
      await expect.poll(() => decorationOf(cell)).toBe("none");
      await expect(cell).toHaveText(["z"]);
      release();
    });

    test("at a 300 ms round trip a predicted cell is underlined", async ({ page }) => {
      test.setTimeout(60_000);
      const { terminal, link } = await open(page);
      const line = await settle(page, terminal, link, "", 300);
      // Over 300 ms of injected delay alone the SRTT stays above 160 ms however fast the runner is.
      const state = await described(page);
      expect(measured(await roundTrips(page)).flagging, state).toBe(true);
      expect(await drawnDecoration(page, terminal, link, line), state).toBe("underline");
    });
  });
}
