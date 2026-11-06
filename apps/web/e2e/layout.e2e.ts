// No box on any screen overflows, at every window the app targets, in both themes, with the layout host's long
// names, titles and paths. LAYOUT_OUT=<dir> also saves each screen and its findings there.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCREENS, STARTS } from "./layout-screens.ts";
import { findOverflows } from "./overflow.ts";
import { expect, test } from "./fixtures.ts";
import { clearLayoutHost, clearLayouts } from "./layout-doc.ts";

const VIEWPORTS = [
  { name: "1470x956@2", viewport: { width: 1470, height: 956 }, deviceScaleFactor: 2, narrow: false, inset: false },
  { name: "1280x800@2", viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, narrow: false, inset: false },
  // The desktop shell's top-left inset for its window buttons; the other 1280 viewport covers the browser.
  {
    name: "1280x800@1+inset",
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    narrow: false,
    inset: true,
  },
  { name: "390x844@3", viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, narrow: true, inset: false },
] as const;
/** The live terminal draws its own grid. */
const SKIP = ["[data-terminal]"];
/** A spinning glyph's box grows as it turns; measure every box at rest. */
const AT_REST = "*, ::before, ::after { animation: none !important; transition: none !important; }";
/** What the macOS app sets beside its window buttons (apps/desktop TITLEBAR_INSET_START). */
const INSET = 78;
const DESKTOP_INSET = `:root { --titlebar-inset-start: ${INSET}px; }`;
const BROKEN_STORAGE = `IDBFactory.prototype.open = () => { throw new DOMException("IndexedDB is not available here", "InvalidStateError"); };`;
const OUT = process.env["LAYOUT_OUT"];
/** Where each visible titlebar in the window buttons' corner starts its content. */
const cornerStarts = (inset: number): number[] =>
  [...document.querySelectorAll("[data-titlebar]")].flatMap((el) => {
    const box = el.getBoundingClientRect();
    if (!el.checkVisibility() || box.top > 1 || box.left >= inset) return [];
    return [box.left + Number.parseFloat(getComputedStyle(el).paddingLeft)];
  });

test.use({ serviceWorkers: "block" });

for (const { name: size, narrow, inset, ...use } of VIEWPORTS) {
  for (const theme of ["day", "night"] as const) {
    const screens = SCREENS.filter((screen) => screen.only === undefined || (screen.only === "narrow") === narrow);
    for (const screen of screens) {
      test(`${screen.name} at ${size} in ${theme} overflows nowhere`, async ({ browser }) => {
        // Each screen opens on what it sets up itself, not on the tabs and splits an earlier screen saved in the core.
        clearLayouts();
        clearLayoutHost();
        const context = await browser.newContext({
          ...use,
          isMobile: narrow,
          hasTouch: narrow,
          colorScheme: theme === "day" ? "light" : "dark",
        });
        const stored = STARTS[screen.start];
        await context.addInitScript(
          ([chosen, value]) => {
            localStorage.setItem("doriface.appearance", JSON.stringify({ theme: chosen, custom: [] }));
            if (value === null) localStorage.removeItem("doriface.connection");
            else localStorage.setItem("doriface.connection", value);
          },
          [theme, stored === null ? null : JSON.stringify(stored)] as const,
        );
        if (screen.storageFails === true) await context.addInitScript({ content: BROKEN_STORAGE });
        const page = await context.newPage();
        await screen.open(page, narrow);
        await page.mouse.move(0, 0);
        await page.evaluate(() => document.fonts.ready);
        await page.addStyleTag({ content: AT_REST });
        if (inset) await page.addStyleTag({ content: DESKTOP_INSET });
        const corner = await page.evaluate(cornerStarts, INSET);
        // Settings opens as a dialog over the workspace (#843), and the workspace behind it draws no titlebar: the
        // dialog is the screen, so its own left edge is what has to clear the window buttons. Measured in the page, not
        // through a locator: every other screen has no dialog, and a locator would wait for one that never comes.
        const dialog = await page.evaluate(() => {
          const panel = document.querySelector("[data-settings-dialog]");
          return panel === null ? null : { x: panel.getBoundingClientRect().x };
        });
        const found = await page.evaluate(findOverflows, SKIP);
        if (OUT !== undefined) {
          const file = join(OUT, `${screen.name}-${size}-${theme}`);
          mkdirSync(OUT, { recursive: true });
          await page.screenshot({ path: `${file}.png`, animations: "disabled" });
          writeFileSync(`${file}.json`, JSON.stringify(found, null, 1));
        }
        await context.close();
        // Every workspace screen has a titlebar under the window buttons, and each one starts past them; a screen that
        // is the settings dialog clears them with its own panel instead.
        if (inset && dialog !== null) expect(dialog.x).toBeGreaterThanOrEqual(INSET);
        else if (inset && screen.start === "layout") expect(corner.length).toBeGreaterThan(0);
        if (inset) expect(corner.filter((start) => start < INSET)).toEqual([]);
        expect(found).toEqual([]);
      });
    }
  }
}
