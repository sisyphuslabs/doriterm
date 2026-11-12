import { endAgent, startShell } from "./agents.ts";
import { SHOTS } from "./capture-shots.ts";
import { expect, test } from "./fixtures.ts";

test.use({ serviceWorkers: "block" });

let shell = "";
test.beforeEach(() => {
  shell = startShell("host", "shell");
});
test.afterEach(() => {
  endAgent("host", shell);
});

for (const width of [390, 1440] as const) {
  for (const theme of ["day", "night"] as const) {
    test.describe(`${width} ${theme}`, () => {
      test.use({
        viewport: { width, height: width === 390 ? 844 : 900 },
        hasTouch: width === 390,
        isMobile: width === 390,
        deviceScaleFactor: width === 390 ? 3 : 1,
        colorScheme: theme === "day" ? "light" : "dark",
      });
      for (const name of ["voice-listening", "voice-ready"]) {
        test(`${name} reading text meets the design floor`, async ({ page }, testInfo) => {
          await page.addInitScript((chosen) => {
            localStorage.setItem("doriface.appearance", JSON.stringify({ theme: chosen, custom: [] }));
          }, theme);
          const shot = SHOTS.find((entry) => entry.name === name);
          if (shot === undefined) throw new Error(`capture ${name} is missing`);
          await shot.run(page, width === 390 ? "390" : "1440");
          await page.mouse.move(0, 0);
          await page.evaluate(() => document.fonts.ready);
          await page.screenshot({ path: testInfo.outputPath(`${name}-${width}-${theme}.png`), animations: "disabled" });
          const bodySize = width === 390 ? "17px" : "14px";
          const secondarySize = width === 390 ? "15px" : "14px";
          if (name === "voice-listening") {
            const strip = page.locator("[data-voice-strip]");
            await expect.soft(strip.getByText(/Then run the$/)).toHaveCSS("font-size", bodySize);
            await expect.soft(strip.getByRole("status")).toHaveCSS("font-size", secondarySize);
          } else {
            await expect
              .soft(page.getByRole("textbox", { name: "Transcript for shell" }))
              .toHaveCSS("font-size", bodySize);
            await expect
              .soft(page.getByText("Types at the cursor. Return in the terminal sends it."))
              .toHaveCSS("font-size", secondarySize);
          }
        });
      }
    });
  }
}

// Every visible paragraph a person reads on desktop is at least 14 px. Code, key caps and labels inside
// controls, monospace identifiers and captions are not reading text (the same classification the visual gate uses).
test.describe("1440 day reading paragraphs", () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "light" });
  for (const name of [
    "settings",
    "settings-mesh",
    "settings-this device",
    "settings-terminal",
    "pair",
    "pair-code",
    "voice-ready",
  ]) {
    test(`${name} paragraphs are at least 14 px`, async ({ page }) => {
      const shot = SHOTS.find((entry) => entry.name === name);
      if (shot === undefined) throw new Error(`capture ${name} is missing`);
      await shot.run(page, "1440");
      await page.mouse.move(0, 0);
      await page.evaluate(() => document.fonts.ready);
      const { measured, small } = await page.evaluate(() => {
        const reading = [...document.querySelectorAll("body p, body p *")]
          .filter((el) => [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent?.trim()))
          .filter(
            (el) => !el.closest("h1,h2,h3,h4,h5,h6,[role=heading],code,pre,kbd,samp,.term-row,.font-mono,figcaption"),
          )
          .filter((el) => !el.closest("button,[role=button],[role=tab],[role=menuitem],label,[role=alert]"))
          .filter((el) => {
            const style = getComputedStyle(el);
            const box = el.getBoundingClientRect();
            if (style.visibility !== "visible" || style.display === "none" || Number(style.opacity) === 0) return false;
            if (box.width < 2 || box.height < 2 || box.bottom <= 0 || box.top >= innerHeight) return false;
            if (box.right <= 0 || box.left >= innerWidth) return false;
            for (let parent = el.parentElement; parent; parent = parent.parentElement) {
              const parentStyle = getComputedStyle(parent);
              if (parentStyle.display === "none" || parentStyle.visibility === "hidden") return false;
              if (Number(parentStyle.opacity) === 0) return false;
            }
            return true;
          })
          .map((el) => ({ text: (el.textContent ?? "").trim().slice(0, 60), size: getComputedStyle(el).fontSize }));
        return { measured: reading.length, small: reading.filter((entry) => parseFloat(entry.size) < 14) };
      });
      // The screen has reading text to measure, so an empty list below means it is all large enough (#2356).
      expect(measured, `${name} has reading paragraphs to measure`).toBeGreaterThan(0);
      expect(small).toEqual([]);
    });
  }

  // A notice's title and explanation are reading text too, though the paragraph check above leaves alerts out.
  for (const name of ["storage-error", "pair-refused-4410"]) {
    test(`${name} notice text is at least 14 px`, async ({ page }) => {
      const shot = SHOTS.find((entry) => entry.name === name);
      if (shot === undefined) throw new Error(`capture ${name} is missing`);
      if (shot.storageFails === true) {
        await page.addInitScript(() => {
          IDBFactory.prototype.open = () => {
            throw new DOMException("IndexedDB is not available here", "InvalidStateError");
          };
        });
      }
      await shot.run(page, "1440");
      await page.evaluate(() => document.fonts.ready);
      const read = await page.evaluate(() =>
        [
          ...document.querySelectorAll(
            "div[role=alert] p, div[role=alert] p ~ div, div[role=status] p, div[role=status] p ~ div",
          ),
        ]
          .filter((el) => !el.closest(".sr-only,button,code,kbd,.font-mono") && (el.textContent ?? "").trim() !== "")
          .filter((el) => el.getBoundingClientRect().width > 1)
          .map((el) => ({ text: (el.textContent ?? "").trim().slice(0, 60), size: getComputedStyle(el).fontSize })),
      );
      expect(read.length, "a notice paragraph is on screen").toBeGreaterThan(0);
      expect(read.filter((entry) => parseFloat(entry.size) < 14)).toEqual([]);
    });
  }
});
