import { expect, openNewTerminal, terminalCount, test } from "./fixtures.ts";
import { pressShortcut } from "./platform-keys.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

test("a terminal that becomes ready under the open palette does not take its focus", async ({ page }) => {
  await page.goto("/");
  await openNewTerminal(page);

  // Hold the terminal core so the restored terminal is not ready until the palette is open.
  const gate = Promise.withResolvers<void>();
  await page.route("**/*.wasm", async (route) => {
    await gate.promise;
    await route.continue();
  });
  await page.reload();
  const combobox = page.getByRole("combobox", { name: "Command" });
  await page.getByRole("button", { name: "Command palette" }).first().click();
  await expect(combobox).toBeFocused();

  gate.resolve();
  const terminal = page.locator('[data-focused="true"] [data-terminal]');
  await expect(terminal).toContainText("$", { timeout: 15_000 });

  await page.keyboard.type("qqmarker");
  await expect(combobox).toBeFocused();
  await expect(combobox).toHaveValue("qqmarker");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeHidden();
  await expect(terminal).not.toContainText("qqmarker");
});

test("the open palette keeps keyboard input while a terminal starts and waits for its attach reply", async ({
  page,
}) => {
  await page.goto("/");
  await openNewTerminal(page);
  const core = Promise.withResolvers<void>();
  await page.route("**/*.wasm", async (route) => {
    await core.promise;
    await route.continue();
  });
  const held: (string | Buffer)[] = [];
  const state = { holding: false, toPage: (_message: string | Buffer): void => undefined };
  await page.routeWebSocket("**/v1/hc", (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    state.toPage = (message) => ws.send(message);
    server.onMessage((message) => (state.holding ? held.push(message) : ws.send(message)));
  });
  await page.reload();
  await terminalCount(page);
  const combobox = page.getByRole("combobox", { name: "Command" });
  await page.getByRole("button", { name: "Command palette" }).first().click();
  await expect(combobox).toBeFocused();

  state.holding = true;
  core.resolve();
  await expect(page.locator('[data-focused="true"] [data-terminal]').getByRole("textbox")).toBeAttached({
    timeout: 15_000,
  });
  await page.keyboard.type("abc");
  await expect(combobox).toBeFocused();
  await expect(combobox).toHaveValue("abc");

  state.holding = false;
  for (const message of held.splice(0)) state.toPage(message);
  await expect(page.locator('[data-focused="true"] [data-terminal]')).toContainText("$", { timeout: 15_000 });
  await expect(combobox).toHaveValue("abc");
});

// The app opens in Night whatever the device prefers (default-appearance.e2e.ts), so each run stores its theme before
// the load; the device scheme is the other one, so only the stored pick can make the theme on screen the measured one.
for (const theme of ["day", "night"] as const) {
  test.describe(`palette focus ring, ${theme}`, () => {
    test.use({ viewport: { width: 1440, height: 900 }, colorScheme: theme === "day" ? "dark" : "light" });

    test.beforeEach(async ({ page }) => {
      await page.addInitScript(
        (chosen) => localStorage.setItem("doriface.appearance", JSON.stringify({ theme: chosen, custom: [] })),
        theme,
      );
    });

    test("the palette field opened from the keyboard is ringed in the theme's own colour (#1495)", async ({
      page,
    }, testInfo) => {
      await page.goto("/");
      await expect
        .poll(() => page.evaluate(() => document.documentElement.style.colorScheme))
        .toBe(theme === "day" ? "light" : "dark");

      const opener = (await openNewTerminal(page)).getByRole("textbox");
      await opener.focus();
      await pressShortcut(page, "app.palette");
      const combobox = page.getByRole("combobox", { name: "Command" });
      await expect(combobox).toBeFocused();
      // The field draws the ring as an outline in --ring (packages/ui/src/components/command-palette.tsx), and the probe
      // is the browser's own resolution of that token, so any other outline, or this one in the other theme, fails here.
      const style = await combobox.evaluate((input) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--ring)";
        document.body.append(probe);
        const ring = getComputedStyle(probe).color;
        probe.remove();
        const computed = getComputedStyle(input);
        return {
          outline: computed.outlineStyle,
          width: Number.parseFloat(computed.outlineWidth),
          color: computed.outlineColor,
          ring,
        };
      });
      await page.screenshot({ path: testInfo.outputPath(`palette-focus-1440-${theme}.png`), animations: "disabled" });
      console.log(`${theme}: ${JSON.stringify(style)}`);
      expect(style.outline, JSON.stringify(style)).toBe("solid");
      expect(style.width, JSON.stringify(style)).toBeGreaterThanOrEqual(2);
      expect(style.color, JSON.stringify(style)).toBe(style.ring);
    });
  });
}
