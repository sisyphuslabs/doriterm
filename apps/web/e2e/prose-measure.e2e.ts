import type { Locator } from "@playwright/test";
import { PAIRING_SETTINGS } from "./capture-relay.ts";
import { SHOTS, type Start } from "./capture-shots.ts";
import { E2E_HOST_PORT, E2E_TOKEN } from "./config.ts";
import { expect, test } from "./fixtures.ts";

test.use({ serviceWorkers: "block" });

const STORED: Readonly<Record<Start, string | null>> = {
  connected: JSON.stringify({
    mode: "loopback",
    relayUrl: "",
    directUrl: "",
    hostId: "",
    loopbackUrl: `ws://127.0.0.1:${E2E_HOST_PORT}/v1/hc`,
    token: E2E_TOKEN,
  }),
  pairing: JSON.stringify(PAIRING_SETTINGS),
  none: null,
};

/** The reading paragraphs of each screen, by a phrase each one contains. */
const DESKTOP: Readonly<Record<string, readonly string[]>> = {
  "first-run": ["Open an invite from a machine you can see"],
  settings: ["This app talks to one host"],
  "settings-mesh": [
    "These are the computers this host reaches",
    "Adding one by hand reaches it without the mesh",
    "reaches the other machines through its own relay only",
  ],
};

/**
 * The fewest full lines each screen wraps to at the measure. The join entry's one sentence fills a line and a bit at both
 * widths, so it has one. (The mesh invite's one sentence fits a single desktop line at the measure, so it has nothing to
 * measure there.)
 */
const LINES: Readonly<Record<string, number>> = { "first-run": 1 };

/** Characters on each rendered line but the last, read from DOM ranges the way the page draws them. */
const fullLines = (paragraph: Locator) =>
  paragraph.evaluate((el) => {
    const lines = new Map<number, string>();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = node.textContent ?? "";
      for (let i = 0; i < value.length; i++) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const box = range.getBoundingClientRect();
        if (!box.width || !box.height) continue;
        const y = Math.round(box.top * 2) / 2;
        lines.set(y, (lines.get(y) ?? "") + value[i]);
      }
    }
    return [...lines.values()].slice(0, -1).map((text) => [...text.trim()].length);
  });

for (const [width, screens] of [
  [1440, DESKTOP],
  [
    390,
    {
      "first-run": ["Open an invite from a machine you can see"],
    },
  ],
] as const) {
  for (const [name, phrases] of Object.entries(screens)) {
    test(`${name} at ${width} sets reading prose to a comfortable measure`, async ({ browser }) => {
      const shot = SHOTS.find((entry) => entry.name === name);
      if (shot === undefined) throw new Error(`capture ${name} is missing`);
      const phone = width === 390;
      const context = await browser.newContext({
        viewport: { width, height: phone ? 844 : 900 },
        hasTouch: phone,
        isMobile: phone,
        deviceScaleFactor: phone ? 3 : 1,
        serviceWorkers: "block",
      });
      await context.addInitScript((stored) => {
        if (stored === null) localStorage.removeItem("doriface.connection");
        else localStorage.setItem("doriface.connection", stored);
      }, STORED[shot.start]);
      const page = await context.newPage();
      try {
        await shot.run(page, phone ? "390" : "1440");
        await page.evaluate(() => document.fonts.ready);
        // The measure is in em, set for the faces the app names (SF Pro on Apple platforms, Segoe UI on Windows). A Linux
        // runner has none of them and its browser draws a wider fallback face, which sets the same measure about a tenth
        // shorter. The browser runs on this machine, so its platform is the runner's.
        const platformFace = process.platform !== "linux";
        const floor = Math.round(65 * (platformFace ? 1 : 0.9));
        const measured = await Promise.all(
          phrases.map(async (phrase) => {
            const paragraph = page.locator("p").filter({ hasText: phrase }).first();
            await expect(paragraph).toBeVisible();
            return [phrase, await fullLines(paragraph)] as const;
          }),
        );
        // fullLines drops each paragraph's last line, so one-line paragraphs measure nothing and a screen that renders
        // all of them as one line passes every floor below vacuously. Every screen must wrap to at least its LINES (2
        // where unlisted); a Linux runner without the named faces draws a wider fallback, which wraps more lines, not
        // fewer, so this floor holds there too.
        const screenLines = measured.reduce((total, [, lines]) => total + lines.length, 0);
        expect(
          screenLines,
          `${name} at ${width}: ${measured.map(([phrase, lines]) => `${lines.length} full lines in "${phrase}"`).join(", ")}`,
        ).toBeGreaterThanOrEqual(LINES[name] ?? 2);
        if (phone) {
          // A phone line is too short for a character floor to be fair: where one word breaks moves a full line by a
          // whole word (37 or 41 characters on a Linux fallback face for the same column). What the phone needs is the
          // whole column: the prose spans its page's content box, and that box leaves only the 16 px edges of a 390 px
          // screen (dev drew it in a 294 px, then 342 px, column).
          const boxes = await Promise.all(
            measured.map(([phrase]) =>
              page
                .locator("p")
                .filter({ hasText: phrase })
                .first()
                .evaluate((el, said) => {
                  const sheet = el.closest("main") ?? document.body;
                  const style = getComputedStyle(sheet);
                  const column = sheet.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
                  return { phrase: said, prose: el.getBoundingClientRect().width, column, screen: window.innerWidth };
                }, phrase),
            ),
          );
          for (const box of boxes) {
            expect.soft(box.prose, `${box.phrase}: prose width in its column`).toBeGreaterThanOrEqual(box.column - 1);
            expect
              .soft(box.column, `${box.phrase}: column on a ${box.screen} px screen`)
              .toBeGreaterThanOrEqual(box.screen - 32);
          }
        } else {
          for (const [phrase, counts] of measured) {
            for (const count of counts) {
              expect.soft(count, `${phrase}: ${counts.join(",")}`).toBeGreaterThanOrEqual(floor);
              expect.soft(count, `${phrase}: ${counts.join(",")}`).toBeLessThanOrEqual(75);
            }
          }
        }
      } finally {
        shot.cleanup?.();
        await context.close();
      }
    });
  }
}
