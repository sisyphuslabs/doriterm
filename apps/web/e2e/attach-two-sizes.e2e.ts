// #2670: a phone opening a terminal a desktop already shows does not size the pty down to the phone. A view that only
// watches never sizes the host (D1, host-size.ts); the device a person types on does, so the desktop keeps its columns.
import type { Browser, Locator, Page } from "@playwright/test";
import { endAgent, startShell } from "./agents.ts";
import { E2E_HOST_PORT, E2E_TOKEN } from "./config.ts";
import { coreSize, gridSize } from "./core-size.ts";
import { expect, test } from "./fixtures.ts";
import { seedSpaces } from "./layout-doc.ts";
import { fakeSoftKeyboard } from "./phone-key-bar.ts";

test.use({ serviceWorkers: "block" });

/**
 * A phone on the e2e core for the length of `run`: its own context, a phone viewport, and a soft keyboard that only a
 * press raises. The context is closed however `run` or the phone's setup ends, so no page or session outlives the test.
 */
async function withPhone(browser: Browser, run: (phone: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  try {
    const settings = {
      mode: "loopback",
      relayUrl: "wss://relay-doriface.omo.dev",
      directUrl: "",
      hostId: "",
      loopbackUrl: `ws://127.0.0.1:${E2E_HOST_PORT}/v1/hc`,
      token: E2E_TOKEN,
    };
    await context.addInitScript(
      (value) => localStorage.setItem("doriface.connection", value),
      JSON.stringify(settings),
    );
    const phone = await context.newPage();
    await fakeSoftKeyboard(phone);
    await run(phone);
  } finally {
    await context.close();
  }
}

test("a phone opening the terminal a desktop watches leaves the desktop's columns their own width (#2670)", async ({
  page,
  browser,
}) => {
  const address = startShell("host", "two-sizes");
  try {
    seedSpaces([
      {
        id: "spc-two-sizes",
        name: "two-sizes",
        folder: "",
        tabs: [{ id: "tb-two-sizes", name: "", terminal: address }],
      },
    ]);
    await page.goto("/");
    const desktop = page.locator(`[data-terminal="${address}"]`);
    await expect(desktop).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => coreSize(address) === (await gridSize(desktop)), { timeout: 15_000 }).toBe(true);
    const own = await gridSize(desktop);

    await withPhone(browser, async (phone) => {
      const phoneTerminal = phone.locator(`[data-terminal="${address}"]`);
      await phone.goto("/");
      await phone
        .getByRole("button", { name: /two-sizes/ })
        .first()
        .click();
      await expect(phoneTerminal).toBeVisible({ timeout: 20_000 });
      // The phone only watches, so it attaches without taking the pty's size (D1): the program keeps the desktop's.
      await expect.poll(() => coreSize(address), { timeout: 10_000 }).toBe(own);
      // Its focus alone (a person about to type) does not take the size either; only its first input would.
      await phoneTerminal.getByRole("textbox").focus();
      await expect.poll(() => coreSize(address), { timeout: 10_000 }).toBe(own);
      expect(await gridSize(desktop)).toBe(own);
    });
  } finally {
    endAgent("host", address);
  }
});

test("a phone alone on a terminal no device has sized gives it the phone's own grid (#2974)", async ({ browser }) => {
  const address = startShell("host", "phone-alone");
  try {
    seedSpaces([
      {
        id: "spc-phone-alone",
        name: "phone-alone",
        folder: "",
        tabs: [{ id: "tb-phone-alone", name: "", terminal: address }],
      },
    ]);
    const headless = coreSize(address);
    await withPhone(browser, async (phone) => {
      const phoneTerminal = phone.locator(`[data-terminal="${address}"]`);
      await phone.goto("/");
      await phone
        .getByRole("button", { name: /phone-alone/ })
        .first()
        .click();
      await expect(phoneTerminal).toBeVisible({ timeout: 20_000 });
      // No other viewer is more recently active, so the core takes the watching phone's size from its attach.
      await expect
        .poll(async () => coreSize(address) === (await gridSize(phoneTerminal)), { timeout: 10_000 })
        .toBe(true);
      expect(coreSize(address)).not.toBe(headless);
    });
  } finally {
    endAgent("host", address);
  }
});

/** How many of the view's rows hold `text`, history included. */
const rowsWith = (terminal: Locator, text: string): Promise<number> =>
  terminal.evaluate(
    (element, wanted) =>
      [...element.querySelectorAll(".term-row")].filter((row) => row.textContent?.includes(wanted)).length,
    text,
  );

test("a phone only watching draws the program at the pty's size, so a desktop-wide redraw leaves no copies (#2974)", async ({
  page,
  browser,
}) => {
  const address = startShell("host", "watch-redraw");
  try {
    seedSpaces([
      {
        id: "spc-watch-redraw",
        name: "watch-redraw",
        folder: "",
        tabs: [{ id: "tb-watch-redraw", name: "", terminal: address }],
      },
    ]);
    await page.goto("/");
    const desktop = page.locator(`[data-terminal="${address}"]`);
    await expect(desktop).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => coreSize(address) === (await gridSize(desktop)), { timeout: 15_000 }).toBe(true);
    const own = await gridSize(desktop);

    await withPhone(browser, async (phone) => {
      const phoneTerminal = phone.locator(`[data-terminal="${address}"]`);
      await phone.goto("/");
      await phone
        .getByRole("button", { name: /watch-redraw/ })
        .first()
        .click();
      await expect(phoneTerminal).toBeVisible({ timeout: 20_000 });

      // A status row as wide as the desktop, drawn in place five times the way a TUI's footer is: clear the row, draw
      // it, end the line, go back up one row. A grid narrower than the pty wraps the row, so going up one row reaches
      // only its last piece and every earlier draw's first piece stays on the screen.
      await desktop.getByRole("textbox").focus();
      await page.keyboard.type(
        "w=$(stty size | cut -d' ' -f2); bar=$(printf '%*s' $((w-12)) '' | tr ' ' '='); " +
          "for i in 1 2 3 4 5; do printf '\\r\\033[2Kstatus-%s %s\\n\\033[1A' $i \"$bar\"; done; echo; echo drawn-$((40+2))",
      );
      await page.keyboard.press("Enter");
      await expect(phoneTerminal).toContainText("drawn-42", { timeout: 15_000 });
      expect(await rowsWith(phoneTerminal, "status-5")).toBe(1);
      expect(await rowsWith(phoneTerminal, "status-1")).toBe(0);
      // It drew the program at the pty's grid, not one of its own the program never drew for; the desk keeps its size.
      expect(await gridSize(phoneTerminal)).toBe(own);
      expect(coreSize(address)).toBe(own);

      // The desk's window narrows: the core resizes the pty and tells the watching phone, which follows it.
      await page.setViewportSize({ width: 900, height: 600 });
      await expect
        .poll(async () => (await gridSize(desktop)) !== own && (await gridSize(desktop)) === coreSize(address), {
          timeout: 10_000,
        })
        .toBe(true);
      await expect.poll(() => gridSize(phoneTerminal), { timeout: 10_000 }).toBe(coreSize(address));
    });
  } finally {
    endAgent("host", address);
  }
});
