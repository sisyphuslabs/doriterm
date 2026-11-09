import type { Locator, Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { type HcSocket, routeHcSocket } from "./hc-socket.ts";
import { PHONE, openPhoneTerminal } from "./phone-key-bar.ts";
import { untilShellReads } from "./prediction-probe.ts";

// The real predictor underlines a drawn cell only while it is flagging, as mosh does: its echo SRTT above 160 ms
// (cleared at 100 ms or less), or a glitch. On a link whose echo comes back in about 120 ms a prediction is drawn plain;
// at a relay's 300 ms it is underlined (#1439 HIGH 2).

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

/** Echoes keys with no delay until the predictor's own samples have cleared its flagging. Returns the line typed. */
async function unflagged(page: Page, terminal: Locator, link: HcSocket): Promise<string> {
  link.delay(0);
  let line = "";
  for (const key of `${KEYS}${KEYS}`) {
    line += key;
    // oxlint-disable-next-line no-await-in-loop -- each key's echo is a sample the next one builds on
    await echoed(page, terminal, line);
    // oxlint-disable-next-line no-await-in-loop -- as above
    if (!measured(await roundTrips(page)).flagging) return line;
  }
  throw new Error(`unheld echoes never cleared flagging: ${await described(page)}`);
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

async function cleared(page: Page, terminal: Locator): Promise<void> {
  await page.keyboard.press("Control+U");
  await expect(prompt(terminal).filter({ hasText: /^\$ *$/ })).toHaveCount(1, { timeout: 15_000 });
}

for (const device of ["desktop", "phone"] as const) {
  test.describe(device, () => {
    test.use(device === "phone" ? { ...PHONE, serviceWorkers: "block" } : { serviceWorkers: "block" });

    /** A terminal at its prompt, predictions always drawn, its host frames routed through the spec. */
    async function open(page: Page): Promise<{ readonly terminal: Locator; readonly link: HcSocket }> {
      const link = await routeHcSocket(page);
      await page.addInitScript(() => localStorage.setItem("doriface.terminal.predict-typing", "always"));
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

    test("at a 120 ms round trip a predicted cell is drawn with no underline", async ({ page }) => {
      test.setTimeout(120_000);
      const { terminal, link } = await open(page);
      // The routed socket and a loaded runner add 30-200 ms of their own to an echo, so the injected delay is steered
      // until the predictor measures 100-160 ms without flagging, the state under test: shorter when its SRTT went past
      // 160 ms (flagging, as it should), longer when it stayed at 100 ms or less.
      let line = "";
      let delay = 60;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        // oxlint-disable-next-line no-await-in-loop -- each attempt starts from the last one's line and delay
        if (line !== "") await cleared(page, terminal);
        // oxlint-disable-next-line no-await-in-loop -- as above
        line = await settle(page, terminal, link, await unflagged(page, terminal, link), delay);
        // oxlint-disable-next-line no-await-in-loop -- as above
        const { srtt, flagging } = measured(await roundTrips(page));
        if (!flagging && srtt > 100) break;
        delay = Math.max(0, delay + (flagging ? -30 : 30));
      }
      const state = await described(page);
      const { srtt, flagging } = measured(await roundTrips(page));
      expect(flagging, state).toBe(false);
      expect(srtt, state).toBeGreaterThan(100);
      expect(await drawnDecoration(page, terminal, link, line), state).toBe("none");
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
