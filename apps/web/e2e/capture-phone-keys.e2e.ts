// Visual QA captures of the phone terminal's keys, field and held touch at 390, in both themes (#664-#667).
// CAPTURE=1 bunx playwright test capture-phone-keys
import { devices } from "@playwright/test";
import { join } from "node:path";
import { E2E_HOST_PORT, E2E_TOKEN } from "./config.ts";
import { expect, test } from "./fixtures.ts";
import { key, openPhoneTerminal } from "./phone-key-bar.ts";
import { pointOn } from "./terminal-points.ts";
import { Touch } from "./touch.ts";

const OUT = join(import.meta.dirname, "../../../docs/design/app");
const STORED = JSON.stringify({
  mode: "loopback",
  relayUrl: "",
  directUrl: "",
  hostId: "",
  loopbackUrl: `ws://127.0.0.1:${E2E_HOST_PORT}/v1/hc`,
  token: E2E_TOKEN,
});

test.skip(process.env["CAPTURE"] !== "1", "captures run only with CAPTURE=1");

// bar: the keys with the soft keyboard up; down: the same keys once it is put down (#2499).
const SHOTS = ["bar", "down", "input", "select", "paste"] as const;

for (const theme of ["day", "night"] as const) {
  for (const shot of SHOTS) {
    test(`${shot} ${theme}`, async ({ browser }) => {
      const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
      const context = await browser.newContext({ ...phone, colorScheme: theme === "day" ? "light" : "dark" });
      await context.addInitScript(
        ([chosen, stored]) => {
          localStorage.setItem("doriface.appearance", JSON.stringify({ theme: chosen, custom: [] }));
          localStorage.setItem("doriface.connection", stored);
        },
        [theme, STORED] as const,
      );
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      const page = await context.newPage();
      try {
        const terminal = await openPhoneTerminal(page);
        await page.keyboard.type("printf 'keys-%s\\n' 'a line to select from'\r");
        await expect(terminal).toContainText("keys-a line to select from", { timeout: 15_000 });
        if (shot === "down") {
          await key(page, "Hide keyboard").click();
          await expect(key(page, "Show keyboard")).toBeVisible();
        }
        if (shot === "input") {
          await page.getByLabel("Type into the terminal").click();
          await expect(page.getByLabel("Type into the terminal")).toBeFocused();
          await page.keyboard.type("echo 안녕하세요");
        }
        if (shot === "select") {
          const point = await pointOn(terminal, "keys-a line to select from", "select");
          const touch = await Touch.on(page);
          await touch.down(point);
          await expect(page.locator(".term-selection-cells > div").first()).toBeVisible();
          await touch.up(point);
          await expect(page.getByRole("menu", { name: "Selected text" })).toBeVisible();
        }
        if (shot === "paste") {
          await page.evaluate(() => navigator.clipboard.writeText("안녕하세요, 붙여넣었습니다"));
          await key(page, "Paste").click();
          await expect(terminal).toContainText("붙여넣었습니다", { timeout: 15_000 });
        }
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: join(OUT, `mobile-keys-${shot}-390-${theme}.png`), animations: "disabled" });
      } finally {
        await context.close();
      }
    });
  }
}
