import { devices, type Locator, type Page } from "@playwright/test";
import { endAgent, startAgent, startShell } from "./agents.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { openPhoneTerminal } from "./phone-key-bar.ts";
import { stubSpeech } from "./speech-stub.ts";

// Every text field keeps a label a sighted person can read while typing; the placeholder only shows the format (#1497).
test.use({ serviceWorkers: "block" });

const FIND = process.platform === "darwin" ? "Meta+f" : "Control+Shift+F";

/**
 * The field's own label, as drawn: its box, whether an ancestor clips it, its effective opacity and its text; and that
 * neither the field nor the box holding it and its label is cut off, nor the page pushed wider than the screen.
 */
async function expectVisibleLabel(field: Locator): Promise<void> {
  await expect(field).toBeVisible();
  await field.scrollIntoViewIfNeeded();
  const label = await field.evaluate((el) => {
    const input = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : null;
    const byId = document.getElementById((el.getAttribute("aria-labelledby") ?? "").split(" ")[0] ?? "");
    const target = byId ?? input?.labels?.[0] ?? null;
    if (target === null) return null;
    /** Whether a scrolling or clipping ancestor of `node` cuts its box, by more than sub-pixel rounding. */
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends this function as source, so its helpers live inside it
    const cut = (node: Element): boolean => {
      const own = node.getBoundingClientRect();
      for (let parent = node.parentElement; parent !== null; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.clipPath !== "none") return true;
        if (style.overflowX === "visible" && style.overflowY === "visible") continue;
        const outer = parent.getBoundingClientRect();
        if (
          own.left < outer.left - 0.5 ||
          own.right > outer.right + 0.5 ||
          own.top < outer.top - 0.5 ||
          own.bottom > outer.bottom + 0.5
        )
          return true;
      }
      return false;
    };
    let container: Element | null = el.parentElement;
    while (container !== null && !container.contains(target)) container = container.parentElement;
    const root = document.documentElement;
    const layout = {
      fieldClipped: cut(el),
      containerClipped: container === null || cut(container),
      pageOverflow: Math.max(0, root.scrollWidth - root.clientWidth),
    };
    const box = target.getBoundingClientRect();
    let opacity = 1;
    let clipped = false;
    for (let node: Element | null = target; node !== null; node = node.parentElement) {
      const style = getComputedStyle(node);
      opacity *= Number(style.opacity);
      if (style.clipPath !== "none" || (style.clip !== "auto" && style.clip !== "")) clipped = true;
      if (node !== target && style.overflow !== "visible") {
        const outer = node.getBoundingClientRect();
        if (box.left < outer.left || box.right > outer.right || box.top < outer.top || box.bottom > outer.bottom)
          clipped = true;
      }
    }
    return {
      width: Math.round(box.width),
      height: Math.round(box.height),
      srOnly: target.classList.contains("sr-only"),
      clipped,
      opacity,
      text: target.textContent?.trim() ?? "",
      placeholder: el.getAttribute("placeholder") ?? "",
      layout,
    };
  });
  expect(label, "the field has an associated label").not.toBeNull();
  if (label === null) return;
  expect(label.width).toBeGreaterThan(1);
  expect(label.height).toBeGreaterThan(1);
  expect(label).toMatchObject({ srOnly: false, clipped: false, opacity: 1 });
  expect(label.text).not.toBe("");
  expect(label.text).not.toBe(label.placeholder);
  expect(label.layout).toEqual({ fieldClipped: false, containerClipped: false, pageOverflow: 0 });
}

const settingsDialog = (page: Page) => page.getByRole("dialog", { name: "Settings" });

for (const width of [390, 1440] as const) {
  test.describe(`${width}`, () => {
    const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
    test.use(width === 390 ? phone : { viewport: { width: 1440, height: 900 } });

    test("the command palette's search shows its label", async ({ page }) => {
      await page.goto("/");
      await page
        .getByRole("button", { name: width === 390 ? "Command palette" : /Commands/ })
        .first()
        .click();
      const field = page.getByRole("combobox", { name: "Command", exact: true });
      await expect(field).toBeFocused();
      await expectVisibleLabel(field);
    });

    test("every Settings search field shows its label", async ({ page }) => {
      await page.goto("/settings");
      const settings = settingsDialog(page);
      await expectVisibleLabel(settings.getByRole("searchbox", { name: "Search settings" }));
      const open = async (name: string) => {
        await settings
          .getByRole(width === 390 ? "tab" : "button", { name, exact: true })
          .first()
          .click();
        await expect(settings.getByRole("heading", { name, level: 2 })).toBeVisible();
      };
      await open("Keybindings");
      await expectVisibleLabel(settings.getByRole("searchbox", { name: "Search keybindings" }));
      await open("Terminal");
      await expectVisibleLabel(settings.getByRole("searchbox", { name: "Search terminal settings" }));
      await open("Appearance");
      await expectVisibleLabel(settings.getByRole("searchbox", { name: "Search themes" }));
    });

    test("the terminal's find bar shows its label", async ({ page }) => {
      if (width === 390) {
        const terminal = await openPhoneTerminal(page);
        await terminal.locator("textarea").focus();
      } else {
        await page.goto("/");
        await openNewTerminal(page);
      }
      await page.keyboard.press(FIND);
      const field = page.getByRole("searchbox", { name: "Find in terminal" });
      await expect(field).toBeFocused();
      await expectVisibleLabel(field);
    });

    test("the voice transcript shows its label", async ({ page }) => {
      const name = `label-voice-${width}`;
      const address = startShell("host", name);
      try {
        const speech = await stubSpeech(page);
        await page.goto("/");
        await page
          .getByRole("button", { name: new RegExp(name) })
          .first()
          .click();
        await page.getByRole("button", { name: `Dictate into ${name}` }).click();
        await page.getByRole("button", { name: "Allow" }).click();
        await speech.say(["echo labelled", true]);
        await page.getByRole("button", { name: "Done", exact: true }).click();
        await speech.end();
        await expectVisibleLabel(page.getByRole("textbox", { name: `Transcript for ${name}` }));
      } finally {
        endAgent("host", address);
      }
    });
  });
}

// The inline rename lives in the sidebar, which a phone does not draw (a tap there opens the space, and its Rename
// dialog labels its field through Field): it is checked at the narrowest window that has the sidebar, and at 1440.
for (const width of [768, 1440] as const) {
  test(`the inline space rename shows its label at ${width}`, async ({ page }) => {
    const address = startAgent("host", `visible-label-${width}`, "idle", "website");
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      const sidebar = page.getByRole("complementary", { name: "Workspace" });
      await sidebar.getByRole("button", { name: /^website\b/ }).dblclick({ timeout: 20_000 });
      const field = sidebar.getByRole("textbox", { name: "Rename space website" });
      await expect(field).toBeFocused();
      await expectVisibleLabel(field);
      await field.press("Escape");
    } finally {
      endAgent("host", address);
    }
  });
}

// The phone list has no filter field (sidebar-filter.e2e.ts), so the sidebar's filter is checked on the desktop only.
test("the sidebar filter shows its label", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "Workspace" });
  await sidebar.getByRole("button", { name: "Filter sidebar" }).click({ timeout: 20_000 });
  const field = sidebar.getByRole("searchbox", { name: "Filter sidebar" });
  await expect(field).toBeFocused();
  await expectVisibleLabel(field);
});
