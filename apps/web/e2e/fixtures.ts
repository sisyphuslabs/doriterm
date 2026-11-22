import { expect, test as base, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { E2E_HOST_ENV, E2E_HOST_PORT, E2E_TOKEN } from "./config.ts";
import { clearLayouts } from "./layout-doc.ts";
import { type HcSocket, routeHcSocket } from "./hc-socket.ts";
import { pinFonts } from "./pinned-fonts.ts";
import { readSavedEnv } from "./saved-env.ts";
import { beginTest, endTest } from "./terminal-guard.ts";
import { startWorkerHost } from "./worker-host.ts";

/**
 * Every worker runs its own e2e host for as long as it lives (see worker-host.ts). Pages start with loopback dev
 * settings pointing at it, or at `loopbackUrl` when a spec routes another address there. Every test, and every worker
 * as its host stops, is checked for terminals left on that host's core (terminal-guard.ts).
 */
export const test = base.extend<
  { loopbackUrl: string; ownTerminals: undefined; ownPages: undefined; macPage: boolean; pinnedFonts: boolean },
  { e2eHost: undefined }
>({
  // Every page draws with the pinned faces unless a spec opts out to see the platform's own stack (#862).
  pinnedFonts: [true, { option: true }],
  e2eHost: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern; it has none
    async ({}, use) => {
      const stop = await startWorkerHost();
      await use(undefined);
      await stop();
    },
    { scope: "worker", auto: true, timeout: 180_000 },
  ],
  // Set up before beforeEach hooks and torn down after afterEach hooks and the test's pages.
  ownTerminals: [
    // oxlint-disable-next-line no-empty-pattern -- as above
    async ({}, use, testInfo) => {
      const before = beginTest(testInfo);
      await use(undefined);
      endTest(testInfo, before);
    },
    { auto: true },
  ],
  // Playwright closes only the page fixture's context: one a test opens with browser.newContext() stays open for the
  // rest of the worker unless the test closes it, and a test that fails first does not. Its page stays connected to the
  // worker's core and keeps its layout as a device would: a pane whose program ends out of that page's view is dropped
  // for every device (#2122), so a later test's ended pane went before its own page could show it (#2412), and a close
  // whose write the test refused went through from there instead (#2383). Every test therefore closes the contexts it
  // opened, and only those: one a file's beforeAll shares across its tests was there before the test and stays open.
  // Specs that import `test` from @playwright/test run in other workers (this file adds a worker fixture), so they
  // never share a core with these.
  ownPages: [
    async ({ browser }, use) => {
      const before = new Set(browser.contexts());
      await use(undefined);
      await Promise.all(
        browser
          .contexts()
          .filter((context) => !before.has(context))
          .map((own) => own.close()),
      );
    },
    { auto: true },
  ],
  loopbackUrl: [`ws://127.0.0.1:${E2E_HOST_PORT}/v1/hc`, { option: true }],
  // E2E_PAGE_PLATFORM=mac runs every page of a spec that uses this fixture as a Mac on any runner (#1309):
  // navigator.platform reads MacIntel, so the app binds its macOS keymap and a spec's shortcut() presses the macOS chord.
  // A spec that sets the platform itself still can. A spec that imports `test` straight from @playwright/test is not
  // switched.
  macPage: [process.env["E2E_PAGE_PLATFORM"] === "mac", { option: true }],
  context: async ({ context, macPage }, use) => {
    if (macPage) {
      await context.addInitScript(() =>
        Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel", configurable: true }),
      );
    }
    await use(context);
  },
  page: async ({ page, loopbackUrl, pinnedFonts }, use) => {
    if (pinnedFonts) await pinFonts(page);
    const settings = {
      mode: "loopback",
      relayUrl: "wss://relay-doriface.omo.dev",
      directUrl: "",
      hostId: "",
      loopbackUrl,
      token: E2E_TOKEN,
    };
    await page.addInitScript((value) => localStorage.setItem("doriface.connection", value), JSON.stringify(settings));
    clearLayouts();
    await use(page);
  },
});

export { expect } from "@playwright/test";

/**
 * Makes the appearance follow the device, as a person who picked System has it; the default is dark. It writes only
 * when nothing is stored, so a pick made later in the test survives a reload.
 */
export async function followSystemAppearance(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (localStorage.getItem("doriface.appearance") === null)
      localStorage.setItem("doriface.appearance", JSON.stringify({ mode: "system", custom: [] }));
  });
}

/** How many live terminals the e2e core holds, this machine's and the added machine's, as hc lists them. */
function liveOnCore(): number {
  const { hc, env } = readSavedEnv(E2E_HOST_ENV);
  const listed: unknown = JSON.parse(
    execFileSync(hc, ["ls", "--json"], { env: { ...process.env, ...env }, encoding: "utf8" }),
  );
  const terminals = typeof listed === "object" && listed !== null ? Reflect.get(listed, "terminals") : undefined;
  if (!Array.isArray(terminals)) throw new Error("hc ls printed no terminal list");
  return terminals.length;
}

/** "4 terminals", optionally followed by " · 1 needs you". */
const TERMINAL_COUNT = /^\d+ terminals?\b/;

/** The status bar's terminal count. It shows only once the core has listed its terminals, so `before` is never a placeholder 0. */
export async function terminalCount(
  page: Page,
): Promise<{ readonly before: number; readonly grown: () => Promise<void> }> {
  const count = page.getByRole("contentinfo").getByText(TERMINAL_COUNT);
  // The bar reads 0 before the first terminal.list answers (#81), so the baseline is the core's own count.
  const before = liveOnCore();
  await expect(count).toHaveText(new RegExp(`^${before} terminals?\\b`), { timeout: 20_000 });
  const next = new RegExp(`^${before + 1} terminals?\\b`);
  return { before, grown: () => expect(count).toHaveText(next, { timeout: 15_000 }) };
}

/** Opens one more terminal and returns it, pinned by address, once it is the focused pane and its prompt is up. */
export async function openNewTerminal(page: Page): Promise<Locator> {
  const count = await terminalCount(page);
  const focused = page.locator('[data-focused="true"] [data-terminal]');
  // Running terminals show a focused pane, unless every tab was closed while one runs on outside any tab (#354).
  if (count.before > 0) {
    await expect(focused.or(page.getByText("No terminal open"))).toBeVisible({ timeout: 15_000 });
  }
  const known = new Set(
    await page.locator("[data-terminal]").evaluateAll((els) => els.map((el) => el.getAttribute("data-terminal"))),
  );
  await pressNewTab(
    page
      .getByRole("button", { name: "New tab" })
      .or(page.getByRole("button", { name: "New terminal" }))
      .first(),
  );
  await count.grown();
  // The focus moves to the new terminal a moment after it registers; until then the old pane is focused.
  await expect
    .poll(
      async () => {
        const address = await focused.getAttribute("data-terminal").catch(() => null);
        return address !== null && !known.has(address);
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  const address = await focused.getAttribute("data-terminal");
  const terminal = page.locator(`[data-terminal="${address}"]`);
  await expect(terminal).toContainText("$", { timeout: 15_000 });
  return terminal;
}

/** Opens a terminal once the workspace has loaded, with every later frame from the host held `ms`, as over the relay. */
export async function openNewTerminalBehindLatency(
  page: Page,
  ms: number,
): Promise<{ readonly terminal: Locator; readonly link: HcSocket }> {
  const link = await routeHcSocket(page);
  await page.goto("/");
  await terminalCount(page);
  link.delay(ms);
  return { terminal: await openNewTerminal(page), link };
}

type Box = NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>>;

/**
 * The element's box once it is laid out: read before its first layout, boundingBox() is null and a measure reads 0.
 * Any non-empty box counts as laid out, a 1x1 visually hidden element's included: this proves layout, not visibility.
 */
export async function laidOutBox(locator: Locator): Promise<Box> {
  let last: Box | null = null;
  try {
    await expect
      .poll(async () => {
        last = await locator.boundingBox();
        return last !== null && last.width > 0 && last.height > 0;
      })
      .toBe(true);
  } catch (error) {
    throw new Error(`${String(locator)} has no laid-out box (last: ${JSON.stringify(last)})`, { cause: error });
  }
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${String(locator)} lost its box right after it was laid out`);
  return box;
}

/**
 * Presses a New tab button for a new terminal. The desktop strip's opens herdr-app's new menu (#466 item 7), whose
 * Terminal item starts it; the phone header's starts it at once.
 */
export async function pressNewTab(button: Locator, options: { readonly timeout?: number } = {}): Promise<void> {
  await button.click(options);
  if ((await button.getAttribute("aria-haspopup")) === "menu") {
    await button
      .page()
      .getByRole("menuitem", { name: /^Terminal/ })
      .click(options);
  }
}

/**
 * A sheet or dialog once it is open and at rest: visible, past its starting style, and with every animation inside it
 * finished, so a measurement reads its resting size and not a frame of the open transition (#583).
 */
export async function opened(sheet: Locator): Promise<void> {
  await expect(sheet).toBeVisible();
  await expect(sheet).not.toHaveAttribute("data-starting-style");
  await sheet.evaluate(async (el) => {
    await Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished));
  });
}
