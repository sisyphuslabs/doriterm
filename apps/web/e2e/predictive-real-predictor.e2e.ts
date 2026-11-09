import type { CDPSession, Locator, Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { untilShellReads } from "./prediction-probe.ts";

// The real predictor, wired into the view (#1595), with no stand-in: the acceptance of #1439 HIGH 1 and HIGH 3(a).

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const GA = "\u{AC00}";

type Logged = { readonly kind: string; readonly cause?: string };

const predictionMode = (page: Page, mode: "adaptive" | "always" | "never") =>
  page.addInitScript((value) => localStorage.setItem("doriface.terminal.predict-typing", value), mode);

const events = (page: Page) =>
  page.evaluate(() => [...((Reflect.get(window, "__dorifacePredictLog") as Logged[] | undefined) ?? [])]);

const prompt = (terminal: Locator) =>
  terminal.locator(".term-row:not(.term-scrollback-row)").filter({ hasText: /^\$ / });

/** A key the host has echoed, so the predictor's epoch is confirmed and the next keys are drawn. */
async function echoed(page: Page, terminal: Locator, key: string): Promise<void> {
  await page.keyboard.type(key);
  await expect(prompt(terminal).filter({ hasText: `$ ${key}` })).toHaveCount(1, { timeout: 15_000 });
}

test("HIGH 3(a): a Hangul syllable composed with predictions on is predicted, then reaches the screen (#1439)", async ({
  page,
}) => {
  const link = await routeHcSocket(page);
  await predictionMode(page, "always");
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  await untilShellReads(page, terminal);
  await echoed(page, terminal, "e");

  link.delay(300);
  const release = link.holdFromHost("");
  await page.keyboard.type("ab");
  await expect(terminal.locator(".term-prediction-cell")).toHaveText(["a", "b"]);

  const cdp: CDPSession = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: GA, selectionStart: 1, selectionEnd: 1 });
  await expect(terminal.locator(".term-preedit")).toHaveText(GA);
  await cdp.send("Input.insertText", { text: GA });
  // The commit is a key: the composing gate has closed by the time wterm sends it, so it is predicted at once.
  await expect(terminal.locator(".term-prediction-cell")).toHaveText(["a", "b", GA]);

  release();
  await expect(prompt(terminal).filter({ hasText: `$ eab${GA}` })).toHaveCount(1, { timeout: 15_000 });
  await expect(terminal.locator(".term-prediction-cell")).toHaveCount(0);
  expect((await events(page)).filter((event) => event.kind === "reset")).toEqual([]);
});

test("HIGH 1: 200 keys over a jittered, order-preserving link draw predictions and reset none (#1439)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const link = await routeHcSocket(page);
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  await untilShellReads(page, terminal);
  await echoed(page, terminal, "e");
  await page.evaluate(() => {
    Reflect.set(window, "__drewPrediction", false);
    new MutationObserver(() => {
      if (document.querySelector(".term-prediction-cell") !== null) Reflect.set(window, "__drewPrediction", true);
    }).observe(document.body, { childList: true, subtree: true });
  });

  // A relay's round trip, 270-400 ms (#1439), different for each key but never reordering what the host sends.
  let seed = 7;
  const jitter = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return 270 + (seed % 131);
  };
  const words = ["remote", "typing", "feels", "local", "now"];
  let text = "";
  for (let index = 0; text.length < 200; index += 1) text += `${words[index % words.length]} `;
  text = text.slice(0, 200);
  for (const key of text) {
    link.delay(jitter());
    // The typing cadence is the behaviour under test: 70 ms between keys, as #1439 measured.
    await page.keyboard.type(key, { delay: 70 });
  }
  link.delay(0);
  // Every key reaches the host: the active rows, joined across the wraps, hold the whole typed line.
  const typed = text.trimEnd();
  await expect
    .poll(
      () =>
        terminal.evaluate((element) =>
          [...element.querySelectorAll(".term-row:not(.term-scrollback-row)")].map((row) => row.textContent).join(""),
        ),
      { timeout: 30_000 },
    )
    .toContain(typed);
  await expect(terminal.locator(".term-prediction-cell")).toHaveCount(0, { timeout: 15_000 });

  const logged = await events(page);
  expect(await page.evaluate(() => Reflect.get(window, "__drewPrediction"))).toBe(true);
  expect(logged.filter((event) => event.kind === "confirmed")).not.toHaveLength(0);
  expect(logged.filter((event) => event.kind === "reset")).toEqual([]);
  await page.keyboard.press("Control+U");
});
