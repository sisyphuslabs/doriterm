import type { BrowserContext, Locator, Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { fixtureFontWithAdvance } from "./font-fixture.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const HANGUL = "\u{BE0C}\u{B77C}";

/** Prints `text` in the terminal, typed as UTF-8 octal so the keyboard input stays ASCII. */
async function print(page: Page, terminal: Locator, text: string): Promise<void> {
  const octal = [...new TextEncoder().encode(text)].map((byte) => `\\${byte.toString(8)}`).join("");
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type(`printf '${octal}\\n'`);
  await page.keyboard.press("Enter");
}

const wideSizes = (terminal: Locator) =>
  terminal.evaluate((element) =>
    [...element.querySelectorAll(".term-row:not(.term-scrollback-row) .term-wide")].map(
      (span) => getComputedStyle(span).fontSize,
    ),
  );

/**
 * The terminal's configured family: a web font whose W, the cell's advance, is 0.4 em. A fallback face's wide glyphs
 * fit Ghostty's ideograph width, min(ASCII ink height, two cells); this font draws no other ASCII, so the ink height
 * stays the fallback monospace's (0.9 em and up), and its arrival must narrow the two cells below it to change the fit.
 * A wider cell would not (#691): wherever two cells were already at least the ink height, the fit stays the same.
 */
const HELD = "Held Terminal Fixture";
const HELD_URL = "/held-terminal-fixture.ttf";
const HELD_FONT = fixtureFontWithAdvance(400);

const webFontLoaded = (page: Page) =>
  page.evaluate(
    // A FontFace reports a family with spaces quoted.
    (family) =>
      [...document.fonts].some((face) => face.family.replace(/^"|"$/g, "") === family && face.status === "loaded"),
    HELD,
  );

/** Every page of `context` gets HELD as a web font from HELD_URL, loaded when text first uses it; its response is held until the returned function is called. */
async function holdWebFont(context: BrowserContext): Promise<() => void> {
  const gate = Promise.withResolvers<void>();
  await context.route(`**${HELD_URL}`, async (route) => {
    await gate.promise;
    await route.fulfill({ contentType: "font/ttf", body: HELD_FONT });
  });
  await context.addInitScript(({ family, url }) => document.fonts.add(new FontFace(family, `url(${url})`)), {
    family: HELD,
    url: HELD_URL,
  });
  return gate.resolve;
}

/** Sets the terminal's font-family to HELD in Settings (kept for the context's later pages), and comes back. */
async function useHeldFamily(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Settings" }).first().click();
  await page
    .getByRole("tab", { name: "Terminal", exact: true })
    .or(page.getByRole("button", { name: "Terminal", exact: true }))
    .first()
    .click();
  await page.getByRole("button", { name: "Add font-family", exact: true }).click();
  await page.keyboard.type(HELD);
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Close settings" }).first().click();
}

/** The wide-glyph sizes a page that loaded its web font before drawing any Hangul gets: the reference. */
async function referenceSizes(page: Page): Promise<readonly string[]> {
  const fresh = await page.context().newPage();
  await fresh.goto("/");
  const terminal = await openNewTerminal(fresh);
  await fresh.evaluate((family) => document.fonts.load(`16px "${family}"`), HELD);
  await print(fresh, terminal, HANGUL);
  await expect.poll(async () => (await wideSizes(terminal)).length).toBe(2);
  const sizes = await wideSizes(terminal);
  await fresh.close();
  return sizes;
}

test("a web font that loads while the terminal is under Settings re-sizes wide glyphs measured before it loaded", async ({
  page,
  context,
}) => {
  const release = await holdWebFont(context);
  await page.goto("/");
  await useHeldFamily(page);
  const terminal = await openNewTerminal(page);
  await print(page, terminal, HANGUL);
  await expect.poll(async () => (await wideSizes(terminal)).length).toBe(2);
  const before = await wideSizes(terminal);
  // Too short for the dialog, Settings is a sheet: it keeps the workspace mounted and hidden, so the font arrives under
  // a terminal that is not on screen.
  await page.setViewportSize({ width: 1280, height: 560 });
  await page.getByRole("link", { name: "Settings" }).first().click();
  await expect(page.locator("[data-terminal]")).toBeHidden();
  release();
  await expect.poll(() => webFontLoaded(page), { timeout: 15_000 }).toBe(true);
  await page.getByRole("button", { name: "Close settings" }).first().click();
  const back = page.locator('[data-focused="true"] [data-terminal]');
  await expect(back).toContainText("$", { timeout: 20_000 });
  await print(page, back, HANGUL);
  await expect.poll(async () => (await wideSizes(back)).length).toBe(4);
  const reference = await referenceSizes(page);
  // The held font changes the metrics: the sizes measured before it loaded are not the reference.
  expect(before).not.toEqual(reference);
  expect(await wideSizes(back)).toEqual([...reference, ...reference]);
});

test("a web font that loads while a terminal is mounted re-sizes the wide glyphs already drawn", async ({
  page,
  context,
}) => {
  const release = await holdWebFont(context);
  await page.goto("/");
  await useHeldFamily(page);
  const terminal = await openNewTerminal(page);
  await print(page, terminal, HANGUL);
  await expect.poll(async () => (await wideSizes(terminal)).length).toBe(2);
  const before = await wideSizes(terminal);
  release();
  await expect.poll(() => webFontLoaded(page), { timeout: 15_000 }).toBe(true);
  const reference = await referenceSizes(page);
  expect(before).not.toEqual(reference);
  await expect.poll(() => wideSizes(terminal), { timeout: 10_000 }).toEqual(reference);
});
