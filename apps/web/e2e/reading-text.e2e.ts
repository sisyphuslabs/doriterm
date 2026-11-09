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
      for (const name of ["voice-listening", "voice-ready", "settings-keybindings-spaces"]) {
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
          const secondarySize = width === 390 ? "15px" : "13px";
          if (name === "voice-listening") {
            const strip = page.locator("[data-voice-strip]");
            await expect.soft(strip.getByText(/Then run the$/)).toHaveCSS("font-size", bodySize);
            await expect.soft(strip.getByRole("status")).toHaveCSS("font-size", secondarySize);
          } else if (name === "voice-ready") {
            await expect
              .soft(page.getByRole("textbox", { name: "Transcript for shell" }))
              .toHaveCSS("font-size", bodySize);
            await expect
              .soft(page.getByText("Types at the cursor. Return in the terminal sends it."))
              .toHaveCSS("font-size", secondarySize);
          } else {
            // A row's description, under its title: the action's id here.
            const description = page
              .locator('[id="keybinding-space.select:1"]')
              .locator("xpath=following-sibling::p[1]");
            await expect(description).toBeVisible();
            await expect.soft(description).toHaveCSS("font-size", secondarySize);
          }
        });
      }
    });
  }
}
