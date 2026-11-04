import { devices, type Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { fakeSoftKeyboard } from "./phone-key-bar.ts";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

/** The theme's terminal background token and the open terminal's painted background, both as computed rgb(). */
const backgrounds = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--term-bg").trim();
    document.body.append(probe);
    const token = getComputedStyle(probe).color;
    probe.remove();
    const terminal = document.querySelector('[data-focused="true"] .wterm');
    return { token, terminal: terminal === null ? null : getComputedStyle(terminal).backgroundColor };
  });

/** Switches the system's scheme, waits for the theme token to change, then for the terminal to paint it. */
async function switchTo(page: Page, scheme: "light" | "dark", before: string): Promise<string> {
  await page.emulateMedia({ colorScheme: scheme });
  await expect.poll(async () => (await backgrounds(page)).token).not.toBe(before);
  const { token } = await backgrounds(page);
  await expect.poll(async () => (await backgrounds(page)).terminal, { message: `terminal on ${scheme}` }).toBe(token);
  return token;
}

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];

test.describe("phone", () => {
  test.use({ ...phone });

  test("a terminal listens for the light/dark switch once, however often it re-renders", async ({ page }) => {
    // Counts every `change` listener added to the dark-scheme query, whoever adds it.
    await page.addInitScript(() => {
      const query = "(prefers-color-scheme: dark)";
      const original = window.matchMedia.bind(window);
      let added = 0;
      Object.assign(window, { schemeListenersAdded: () => added });
      window.matchMedia = (asked: string): MediaQueryList => {
        const list = original(asked);
        if (asked !== query) return list;
        const add = list.addEventListener.bind(list);
        Object.assign(list, {
          addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
            if (type === "change") added += 1;
            add(type, listener);
          },
        });
        return list;
      };
    });
    const added = () => page.evaluate(() => (Reflect.get(window, "schemeListenersAdded") as () => number)());
    // The keys bar shows on a touch phone only while the soft keyboard is up.
    await fakeSoftKeyboard(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("banner").getByRole("button", { name: "New tab" }).click();
    await expect(page.locator("[data-terminal]")).toContainText("$", { timeout: 15_000 });
    await expect.poll(added).toBeGreaterThan(0);
    const before = await added();
    // Each tap of the latching ctrl key re-renders the phone terminal screen and its terminal view.
    const ctrl = page.getByRole("button", { name: "Control" });
    const tap = async (pressed: "true" | "false"): Promise<void> => {
      await ctrl.click();
      await expect(ctrl).toHaveAttribute("aria-pressed", pressed);
    };
    await tap("true");
    await tap("false");
    await tap("true");
    await tap("false");
    expect(await added()).toBe(before);
  });
});

test("the open terminal follows a live light/dark switch both ways, keeping its view and scrollback", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type("seq 1 80; echo scheme-$((2+3))\r");
  await expect(terminal).toContainText("scheme-5", { timeout: 20_000 });
  const light = await backgrounds(page);
  expect(light.terminal).toBe(light.token);
  // Marks this view: a remount would replace the element and drop the mark.
  await page.evaluate(() =>
    Object.assign(document.querySelector('[data-focused="true"] .wterm') ?? {}, { kept: true }),
  );
  const rows = await terminal.locator(".term-row").count();

  const dark = await switchTo(page, "dark", light.token);
  await switchTo(page, "light", dark);

  expect(
    await page.evaluate(() => Reflect.get(document.querySelector('[data-focused="true"] .wterm') ?? {}, "kept")),
  ).toBe(true);
  expect(await terminal.locator(".term-row").count()).toBe(rows);
  await expect(terminal).toContainText("scheme-5");
});
