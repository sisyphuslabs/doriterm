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
  "first-run": ["Doriterm shows the terminals and agents of a mesh."],
  "mesh-invite": ["It is not an invite for a browser."],
  pair: ["Open the invite link a member sent you", "The code reaches your host through the relay"],
  settings: ["This app talks to one host"],
  "settings-mesh": [
    "These are the computers this host reaches",
    "Adding one by hand reaches it without the mesh",
    "reaches the other machines through its own relay only",
  ],
};

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
  [390, { "first-run": ["Doriterm shows the terminals and agents of a mesh."] }],
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
        const floor = Math.round((phone ? 42 : 65) * (platformFace ? 1 : 0.9));
        const measured = await Promise.all(
          phrases.map(async (phrase) => {
            const paragraph = page.locator("p").filter({ hasText: phrase }).first();
            await expect(paragraph).toBeVisible();
            return [phrase, await fullLines(paragraph)] as const;
          }),
        );
        for (const [phrase, counts] of measured) {
          for (const count of counts) {
            expect.soft(count, `${phrase}: ${counts.join(",")}`).toBeGreaterThanOrEqual(floor);
            if (!phone) expect.soft(count, `${phrase}: ${counts.join(",")}`).toBeLessThanOrEqual(75);
          }
        }
      } finally {
        shot.cleanup?.();
        await context.close();
      }
    });
  }
}
