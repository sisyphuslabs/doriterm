import { expect, openNewTerminal, terminalCount, test } from "./fixtures.ts";

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

for (const theme of ["day", "night"] as const) {
  test.describe(`palette focus ring, ${theme}`, () => {
    test.use({ viewport: { width: 1440, height: 900 }, colorScheme: theme === "day" ? "light" : "dark" });

    test("the palette field opened from the keyboard shows a focus indicator (#1495)", async ({ page }, testInfo) => {
      await page.goto("/");
      const opener = (await openNewTerminal(page)).getByRole("textbox");
      await opener.focus();
      await page.keyboard.press("ControlOrMeta+Shift+KeyP");
      const combobox = page.getByRole("combobox", { name: "Command" });
      await expect(combobox).toBeFocused();
      const style = await combobox.evaluate((input) => {
        const computed = getComputedStyle(input);
        return {
          visible: input.matches(":focus-visible"),
          outline: computed.outlineStyle,
          shadow: computed.boxShadow,
        };
      });
      await page.screenshot({ path: testInfo.outputPath(`palette-focus-1440-${theme}.png`), animations: "disabled" });
      expect(style.visible).toBe(true);
      expect(style.outline !== "none" || style.shadow !== "none", JSON.stringify(style)).toBe(true);
    });
  });
}
