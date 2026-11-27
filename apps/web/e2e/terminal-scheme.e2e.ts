import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devices, type Locator, type Page } from "@playwright/test";
import { pickFile } from "./file-input.ts";
import { expect, followSystemAppearance, openNewTerminal, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { seedSpaces } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { fakeSoftKeyboard, key } from "./phone-key-bar.ts";

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
    await followSystemAppearance(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("banner").getByRole("button", { name: "New tab" }).click();
    await expect(page.locator("[data-terminal]")).toContainText("$", { timeout: 15_000 });
    // Opening a phone terminal leaves the keyboard down, so the ctrl key is the keyboard button's to bring up (#1375).
    await key(page, "Show keyboard").click();
    await expect.poll(added).toBeGreaterThan(0);
    const before = await added();
    // Each tap of the latching ctrl key re-renders the phone terminal screen and its terminal view.
    const ctrl = page.getByRole("button", { name: "Control", exact: true });
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
  await followSystemAppearance(page);
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

const rgbOf = (page: Page, value: string) =>
  page.evaluate((raw) => {
    const probe = document.createElement("span");
    probe.style.color = raw;
    document.body.append(probe);
    const rgb = getComputedStyle(probe).color;
    probe.remove();
    return rgb;
  }, value);

/** Actual rendered terminal paint: .wterm bg/fg, a rendered ANSI span's computed colour, and the kept-node mark. */
const renderedPaint = (terminal: Locator, marker: string) =>
  terminal.evaluate((root, text) => {
    const wterm = root.classList.contains("wterm") ? root : root.querySelector<HTMLElement>(".wterm");
    if (wterm === null) return null;
    const style = getComputedStyle(wterm);
    const span = [...wterm.querySelectorAll<HTMLElement>(".term-row span")].find(
      (el) => el.textContent?.trim() === text,
    );
    return {
      bg: style.backgroundColor,
      fg: style.color,
      spanColor: span === undefined ? null : getComputedStyle(span).color,
      kept: Reflect.get(wterm, "kept") === true,
    };
  }, marker);

const markKept = (terminal: Locator) =>
  terminal.evaluate((root) => {
    const wterm = root.classList.contains("wterm") ? root : root.querySelector(".wterm");
    if (wterm !== null) Object.assign(wterm, { kept: true });
  });

const spaceRow = (page: Page, name: string) =>
  page
    .getByRole("complementary", { name: "Workspace" })
    .getByRole("region", { name: "Spaces" })
    .getByRole("button", { name: new RegExp(`^${name}\\b`) });

const settingsDialog = (page: Page) => page.getByRole("dialog", { name: "Settings" });

function killStarted(addresses: readonly string[]): void {
  for (const address of addresses) {
    try {
      hcOn("host", ["kill", address]);
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('"kind":"not_found"'))) throw error;
    }
  }
}

function shellIn(cwd: string, name: string, started: string[]): string {
  const out = hcOn("host", ["run", "--bg", "--name", name, "--cwd", cwd, "--", "env", "PS1=$ ", "sh"]);
  const address = String((JSON.parse(out) as { address: string }).address);
  started.push(address);
  return address;
}

function customThemeJson(background: string, foreground: string, red: string, green: string, yellow: string): string {
  return JSON.stringify({
    background,
    foreground,
    selection: "#334455",
    cursor: foreground,
    ansi: [
      "#111111",
      red,
      green,
      yellow,
      "#4488ee",
      "#bb66dd",
      "#33bbbb",
      foreground,
      "#555555",
      red,
      green,
      yellow,
      "#66aaff",
      "#cc88ee",
      "#55dddd",
      "#ffffff",
    ],
  });
}

test("same-kind Appearance theme and custom theme edits repaint split panes and another space in place (#2966)", async ({
  page,
}) => {
  const started: string[] = [];
  const root = mkdtempSync(join(tmpdir(), "terminal-theme-2966-"));
  const alphaDir = mkdtempSync(join(root, "alpha-"));
  const betaDir = mkdtempSync(join(root, "beta-"));
  try {
    const leftAddr = shellIn(alphaDir, "theme-left", started);
    const rightAddr = shellIn(alphaDir, "theme-right", started);
    const betaAddr = shellIn(betaDir, "theme-beta", started);
    seedSpaces([
      {
        id: "spc-alpha",
        name: "alpha",
        folder: alphaDir,
        tabs: [{ id: "tb-alpha", name: "split", terminal: leftAddr, beside: [rightAddr] }],
      },
      {
        id: "spc-beta",
        name: "beta",
        folder: betaDir,
        tabs: [{ id: "tb-beta", name: "other", terminal: betaAddr }],
      },
    ]);

    const link = await routeHcSocket(page);
    await page.goto("/");
    await spaceRow(page, "alpha").click();

    const left = page.locator(`[data-terminal="${leftAddr}"]`);
    const right = page.locator(`[data-terminal="${rightAddr}"]`);
    const beta = page.locator(`[data-terminal="${betaAddr}"]`);
    await expect(left).toContainText("$", { timeout: 20_000 });
    await expect(right).toContainText("$", { timeout: 20_000 });

    hcOn("host", [
      "send",
      leftAddr,
      "printf '\\033[33mscroll-left-%s\\033[0m\\n' 2966; seq 1 60; printf '\\033[31mred-left-%s\\033[0m\\n' 2966",
    ]);
    hcOn("host", [
      "send",
      rightAddr,
      "printf '\\033[33mscroll-right-%s\\033[0m\\n' 2966; seq 1 60; printf '\\033[32mgreen-right-%s\\033[0m\\n' 2966",
    ]);
    await expect(left).toContainText("red-left-2966", { timeout: 20_000 });
    await expect(right).toContainText("green-right-2966", { timeout: 20_000 });

    const nightBg = await rgbOf(page, "#161513");
    const nightFg = await rgbOf(page, "#d8d4cb");
    const nightRed = await rgbOf(page, "#e08a7e");
    const nightGreen = await rgbOf(page, "#a9c08f");
    const nightBlue = await rgbOf(page, "#9fb4e6");

    await expect
      .poll(() => renderedPaint(left, "red-left-2966"))
      .toEqual({
        bg: nightBg,
        fg: nightFg,
        spanColor: nightRed,
        kept: false,
      });
    await expect
      .poll(() => renderedPaint(right, "green-right-2966"))
      .toEqual({
        bg: nightBg,
        fg: nightFg,
        spanColor: nightGreen,
        kept: false,
      });
    await markKept(left);
    await markKept(right);

    // Visit the second space so its terminal is live and mounted too, then switch themes while alpha is hidden.
    await spaceRow(page, "beta").click();
    await expect(beta).toContainText("$", { timeout: 20_000 });
    hcOn("host", [
      "send",
      betaAddr,
      "printf '\\033[33mscroll-beta-%s\\033[0m\\n' 2966; seq 1 60; printf '\\033[34mblue-beta-%s\\033[0m\\n' 2966",
    ]);
    await expect(beta).toContainText("blue-beta-2966", { timeout: 20_000 });
    await expect
      .poll(() => renderedPaint(beta, "blue-beta-2966"))
      .toEqual({
        bg: nightBg,
        fg: nightFg,
        spanColor: nightBlue,
        kept: false,
      });
    await markKept(beta);
    await page.evaluate(() => Object.assign(window, { noReload2966: "same-document" }));

    const attachCount = () => link.sent().filter((frame) => frame.includes('"method":"terminal.attach"')).length;
    const attachesBefore = attachCount();

    // Pick another dark theme (same kind: Night -> Dracula) in the Settings dialog over the live workspace.
    await page.getByRole("link", { name: "Settings" }).click();
    await expect(settingsDialog(page)).toBeVisible();
    await settingsDialog(page).getByRole("button", { name: "Appearance", exact: true }).click();
    await settingsDialog(page)
      .getByRole("radiogroup", { name: "Dark themes" })
      .getByRole("radio", { name: /Dracula/ })
      .click();
    await page.keyboard.press("Escape");
    await expect(settingsDialog(page)).toHaveCount(0);

    const draculaBg = await rgbOf(page, "#282a36");
    const draculaFg = await rgbOf(page, "#f8f8f2");
    const draculaRed = await rgbOf(page, "#ff5555");
    const draculaGreen = await rgbOf(page, "#50fa7b");
    const draculaYellow = await rgbOf(page, "#f1fa8c");
    const draculaBlue = await rgbOf(page, "#bd93f9");

    // Visible space repainted in place with its existing coloured output and DOM node intact.
    await expect
      .poll(() => renderedPaint(beta, "blue-beta-2966"))
      .toEqual({
        bg: draculaBg,
        fg: draculaFg,
        spanColor: draculaBlue,
        kept: true,
      });

    // Returning to the first space shows both split panes repainted in place, scrollback included.
    await spaceRow(page, "alpha").click();
    await expect
      .poll(() => renderedPaint(left, "red-left-2966"))
      .toEqual({
        bg: draculaBg,
        fg: draculaFg,
        spanColor: draculaRed,
        kept: true,
      });
    await expect
      .poll(() => renderedPaint(right, "green-right-2966"))
      .toEqual({
        bg: draculaBg,
        fg: draculaFg,
        spanColor: draculaGreen,
        kept: true,
      });

    // Scroll back to the top of the left split: retained scrollback is intact and painted in Dracula.
    await left.evaluate((rootEl) => {
      const wterm = rootEl.classList.contains("wterm") ? rootEl : rootEl.querySelector<HTMLElement>(".wterm");
      if (wterm !== null) wterm.scrollTop = 0;
    });
    await expect(left).toContainText("scroll-left-2966", { timeout: 10_000 });
    await expect
      .poll(() => renderedPaint(left, "scroll-left-2966"))
      .toEqual({
        bg: draculaBg,
        fg: draculaFg,
        spanColor: draculaYellow,
        kept: true,
      });

    // Importing a custom theme and re-importing under the same filename/id repaints in place too.
    await page.getByRole("link", { name: "Settings" }).click();
    await settingsDialog(page).getByRole("button", { name: "Appearance", exact: true }).click();
    await settingsDialog(page)
      .getByLabel("Theme file")
      .setInputFiles({
        name: "live-2966.json",
        mimeType: "application/json",
        buffer: Buffer.from(customThemeJson("#101820", "#e8e6df", "#ff3344", "#22cc66", "#eedd44")),
      });
    const customV1Bg = await rgbOf(page, "#101820");
    const customV1Fg = await rgbOf(page, "#e8e6df");
    const customV1Green = await rgbOf(page, "#22cc66");
    await expect
      .poll(() => renderedPaint(right, "green-right-2966"))
      .toEqual({
        bg: customV1Bg,
        fg: customV1Fg,
        spanColor: customV1Green,
        kept: true,
      });

    await settingsDialog(page)
      .getByLabel("Theme file")
      .setInputFiles({
        name: "live-2966.json",
        mimeType: "application/json",
        buffer: Buffer.from(customThemeJson("#1a1025", "#f0ece4", "#ee7722", "#33ddaa", "#ffbb44")),
      });
    const customV2Bg = await rgbOf(page, "#1a1025");
    const customV2Fg = await rgbOf(page, "#f0ece4");
    const customV2Green = await rgbOf(page, "#33ddaa");
    await expect
      .poll(() => renderedPaint(right, "green-right-2966"))
      .toEqual({
        bg: customV2Bg,
        fg: customV2Fg,
        spanColor: customV2Green,
        kept: true,
      });

    // Unrelated appearance changes (density) keep the terminal mounted and painted as-is.
    await settingsDialog(page).getByLabel("Density", { exact: true }).getByRole("button", { name: "Compact" }).click();
    await page.keyboard.press("Escape");
    await expect(settingsDialog(page)).toHaveCount(0);

    await expect
      .poll(() => renderedPaint(right, "green-right-2966"))
      .toEqual({
        bg: customV2Bg,
        fg: customV2Fg,
        spanColor: customV2Green,
        kept: true,
      });
    expect(await page.evaluate(() => Reflect.get(window, "noReload2966"))).toBe("same-document");
    expect(attachCount()).toBe(attachesBefore);
  } finally {
    killStarted(started);
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal config colour overrides survive live Appearance theme switches (#2966)", async ({ page }) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  hcOn("host", ["send", address, "printf '\\033[31mover-red-%s\\033[0m \\033[32mover-green-%s\\033[0m\\n' 2966 2966"]);
  await expect(terminal).toContainText("over-green-2966", { timeout: 20_000 });
  await markKept(terminal);

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(settingsDialog(page)).toBeVisible();
  await settingsDialog(page).getByRole("button", { name: "Terminal", exact: true }).click();
  await pickFile(page, "Import Ghostty config…", "config", "background = #112233\npalette = 1=#ff00ff\n");
  const confirm = page.getByRole("dialog", { name: "Import this Ghostty config?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Import" }).click();
  await expect(confirm).toHaveCount(0);

  const overrideBg = await rgbOf(page, "#112233");
  const overrideRed = await rgbOf(page, "#ff00ff");
  const nightFg = await rgbOf(page, "#d8d4cb");
  const nightGreen = await rgbOf(page, "#a9c08f");
  await expect
    .poll(() => renderedPaint(terminal, "over-red-2966"))
    .toEqual({
      bg: overrideBg,
      fg: nightFg,
      spanColor: overrideRed,
      kept: true,
    });
  await expect
    .poll(() => renderedPaint(terminal, "over-green-2966"))
    .toEqual({
      bg: overrideBg,
      fg: nightFg,
      spanColor: nightGreen,
      kept: true,
    });

  // Switch Appearance to Dracula: overridden bg and ANSI 1 stay pinned; non-overridden fg and ANSI 2 update.
  await settingsDialog(page).getByRole("button", { name: "Appearance", exact: true }).click();
  await settingsDialog(page)
    .getByRole("radiogroup", { name: "Dark themes" })
    .getByRole("radio", { name: /Dracula/ })
    .click();
  await page.keyboard.press("Escape");
  await expect(settingsDialog(page)).toHaveCount(0);

  const draculaFg = await rgbOf(page, "#f8f8f2");
  const draculaGreen = await rgbOf(page, "#50fa7b");
  await expect
    .poll(() => renderedPaint(terminal, "over-red-2966"))
    .toEqual({
      bg: overrideBg,
      fg: draculaFg,
      spanColor: overrideRed,
      kept: true,
    });
  await expect
    .poll(() => renderedPaint(terminal, "over-green-2966"))
    .toEqual({
      bg: overrideBg,
      fg: draculaFg,
      spanColor: draculaGreen,
      kept: true,
    });
});
