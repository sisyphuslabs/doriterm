import { devices, type Locator, type Page } from "@playwright/test";
import { endAgent, startAgent } from "./agents.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { machineState, REDIAL_BOUND_MS } from "./machine-switch.ts";
import { resetMeshDocs } from "./mesh-reset.ts";
import { fakeSoftKeyboard, PHONE } from "./phone-key-bar.ts";
import { shortcut } from "./platform-keys.ts";

// Every heading step in use differs by at least 1.25x, and the smallest heading from its body, on every screen (#1578).
test.use({ serviceWorkers: "block" });

const STEP = 1.25;

/**
 * The font sizes a scope draws, as the eye reads them: each heading level's size, and its body's (the size most of its
 * text is set in). Hidden text and the visually-hidden helpers do not count. Text inside a heading (a group's count,
 * #2088) is not the body; any of it drawn larger than its heading is listed as `<heading>: <text> <px>/<heading px>`.
 */
async function scale(
  scope: Locator,
): Promise<{ readonly headings: number[]; readonly body: number; readonly larger: string[] }> {
  return scope.evaluate((root) => {
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends this function as source, so its helpers live inside it
    const shown = (el: Element): boolean => {
      const box = el.getBoundingClientRect();
      return box.width > 1 && box.height > 1 && !el.closest(".sr-only") && getComputedStyle(el).visibility !== "hidden";
    };
    const headings = new Set<number>();
    for (const el of root.querySelectorAll("h1, h2, h3, h4, [role=heading]"))
      if (shown(el)) headings.add(Number.parseFloat(getComputedStyle(el).fontSize));
    const larger: string[] = [];
    const counts = new Map<number, number>();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const parent = node.parentElement;
      const text = node.textContent?.trim() ?? "";
      if (parent === null || text === "" || !shown(parent)) continue;
      const px = Number.parseFloat(getComputedStyle(parent).fontSize);
      const heading = parent.closest("h1, h2, h3, h4, [role=heading]");
      if (heading !== null) {
        const own = Number.parseFloat(getComputedStyle(heading).fontSize);
        // Named by the heading's own words, not its whole text, which would include the count being reported.
        const name = [...heading.childNodes]
          .filter((child) => child.nodeType === Node.TEXT_NODE)
          .map((child) => child.textContent?.trim() ?? "")
          .join(" ")
          .trim();
        if (px > own) larger.push(`${name}: ${text} ${px}/${own}`);
        continue;
      }
      counts.set(px, (counts.get(px) ?? 0) + text.length);
    }
    const body = [...counts.entries()].toSorted((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
    return { headings: [...headings].toSorted((a, b) => b - a), body, larger };
  });
}

/** Each neighbouring pair of distinct sizes, the body among them, as `larger/smaller`, where one is under STEP. */
function tooClose({ headings, body }: { readonly headings: number[]; readonly body: number }): string[] {
  const sizes = [...new Set([...headings, body])].toSorted((a, b) => b - a);
  const close: string[] = [];
  for (let i = 1; i < sizes.length; i += 1) {
    const [larger, smaller] = [sizes[i - 1] ?? 0, sizes[i] ?? 0];
    if (larger / smaller < STEP) close.push(`${larger}/${smaller}=${(larger / smaller).toFixed(3)}`);
  }
  if (headings.includes(body)) close.push(`a heading is the body's ${body} px`);
  return close;
}

async function expectScale(scope: Locator): Promise<{ readonly headings: number[]; readonly body: number }> {
  const measured = await scale(scope);
  expect(measured.headings.length, "the scope draws headings").toBeGreaterThan(0);
  expect(tooClose(measured), JSON.stringify(measured)).toEqual([]);
  expect(measured.larger, "text inside a heading is no larger than the heading").toEqual([]);
  return measured;
}

const settingsDialog = (page: Page) => page.getByRole("dialog", { name: "Settings" });

/** How long Settings > Machines may take to draw its mesh groups once the machine is connected. */
const MESH_GROUPS_MS = 20_000;

for (const width of [390, 1440] as const) {
  test.describe(`${width}`, () => {
    const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
    test.use(width === 390 ? phone : { viewport: { width: 1440, height: 900 } });

    for (const section of ["Keybindings", "Terminal", "Notifications"] as const) {
      test(`Settings > ${section} keeps its heading steps apart`, async ({ page }) => {
        await page.goto("/settings");
        const settings = settingsDialog(page);
        await settings
          .getByRole(width === 390 ? "tab" : "button", { name: section, exact: true })
          .first()
          .click();
        await expect(settings.getByRole("heading", { name: section, level: 2 })).toBeVisible();
        await expectScale(settings);
      });
    }

    // The fixture's mesh documents draw every group, so the case measures MeshGroup's headings, not the loading state.
    // The added machine is connected first, read from the core: a phone's first screen draws no machine row (#2204).
    test("Settings > Machines keeps its mesh groups apart from their rows", async ({ page }) => {
      // Room for both named waits, the core's redial and the mesh groups', past the default 60 s test timeout.
      test.setTimeout(REDIAL_BOUND_MS + MESH_GROUPS_MS + 30_000);
      resetMeshDocs();
      await expect.poll(machineState, { timeout: REDIAL_BOUND_MS }).toBe("connected");
      await page.goto("/settings");
      const settings = settingsDialog(page);
      await settings
        .getByRole(width === 390 ? "tab" : "button", { name: "Machines", exact: true })
        .first()
        .click();
      await expect(settings.locator("[data-mesh-group]").first()).toBeVisible({ timeout: MESH_GROUPS_MS });
      await expectScale(settings);
    });
  });
}

// On a phone (a coarse pointer, so the phone's type tokens) and in a narrow window under a mouse (the desktop tokens),
// as keyboard-settings.e2e.ts reaches the sheet on a phone (#2088).
for (const pointer of ["phone", "mouse"] as const) {
  test.describe(pointer, () => {
    test.use(pointer === "phone" ? PHONE : { viewport: PHONE.viewport, hasTouch: false, isMobile: false });

    test("the Add keys sheet keeps its title, groups and chips apart", async ({ page }) => {
      await fakeSoftKeyboard(page);
      await page.goto("/settings");
      await page.getByRole("tab", { name: "Keyboard" }).click();
      await page.getByRole("button", { name: /^Keys/ }).click();
      const sheet = page.getByRole("dialog", { name: "Add keys" });
      await expect(sheet).toBeVisible();
      // The two pointers draw the sheet from different type tokens, so the case is measured twice, not once: a wrong
      // emulation fails here, by name, rather than as a scale step.
      const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
      expect(coarse).toBe(pointer === "phone");
      const measured = await expectScale(sheet);
      console.log(`Add keys ${pointer}: headings ${measured.headings.join("/")} px, body ${measured.body} px`);
    });
  });
}

test("a dialog's title stands apart from its description", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const address = startAgent("host", "heading-scale-dialog", "idle", "heading-scale");
  try {
    await page.goto("/");
    const sidebar = page.getByRole("complementary", { name: "Workspace" });
    await sidebar.getByRole("button", { name: /^heading-scale(?: |$)/ }).hover({ timeout: 20_000 });
    await sidebar.getByRole("button", { name: "More for heading-scale" }).click();
    await page.getByRole("menuitem", { name: "Rename space\u2026" }).click();
    await expectScale(page.getByRole("dialog", { name: "Rename heading-scale" }));
  } finally {
    endAgent("host", address);
  }
});

test("the keyboard shortcuts dialog keeps its title, groups and rows apart", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const help = await shortcut(page, "app.help");
  await (await openNewTerminal(page)).getByRole("textbox").focus();
  await page.keyboard.press(help);
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog.getByRole("heading", { name: "App" })).toBeVisible();
  await expectScale(dialog);
});
