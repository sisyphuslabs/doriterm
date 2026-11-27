import { devices, type Locator, type Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { machineState, REDIAL_BOUND_MS } from "./machine-switch.ts";
import { resetMeshDocs } from "./mesh-reset.ts";

// The Settings rows that are not SettingRows keep the scale's roles too (#2878, #2882 review): a list row is at least
// 48 px and pads no more than SettingRow, a trailing value is the prose token, and an answer reserves the --control
// height. Each case first requires its role set to be drawn, so a renamed hook fails instead of passing on nothing.
test.use({ serviceWorkers: "block" });

const ROW_FLOOR = 48;
const ROW_PADDING_CEILING = 14;

interface Roles {
  readonly rows: readonly string[];
  readonly values: readonly string[];
  readonly rowCount: number;
  readonly valueCount: number;
}

/** Each row and value under `scope` that misses its role, by its text, and how many of each were drawn. */
async function roles(scope: Locator, rowSelector: string, valueSelector: string): Promise<Roles> {
  return scope.evaluate(
    (root, [rowsAt, valuesAt, floor, ceiling]) => {
      const probe = document.createElement("p");
      probe.className = "text-prose";
      document.body.append(probe);
      const prose = Number.parseFloat(getComputedStyle(probe).fontSize);
      probe.remove();
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends this function as source, so its helpers live inside it
      const name = (el: Element): string => el.textContent?.trim().slice(0, 32) ?? "?";
      const rows = [...root.querySelectorAll(rowsAt)];
      const values = [...root.querySelectorAll(valuesAt)];
      const badRows = rows.flatMap((row) => {
        const height = row.getBoundingClientRect().height;
        const padding = Number.parseFloat(getComputedStyle(row).paddingTop);
        return height >= floor && padding <= ceiling ? [] : [`${name(row)}: ${height}px tall, ${padding}px padding`];
      });
      const badValues = values.flatMap((value) => {
        const size = Number.parseFloat(getComputedStyle(value).fontSize);
        return size === prose ? [] : [`${name(value)}: ${size}px, prose is ${prose}px`];
      });
      return { rows: badRows, values: badValues, rowCount: rows.length, valueCount: values.length };
    },
    [rowSelector, valueSelector, ROW_FLOOR, ROW_PADDING_CEILING] as const,
  );
}

async function expectRoles(scope: Locator, rowSelector: string, valueSelector: string | null): Promise<void> {
  const found = await roles(scope, rowSelector, valueSelector ?? ":not(*)");
  expect(found.rowCount, `rows drawn for ${rowSelector}`).toBeGreaterThan(0);
  if (valueSelector !== null) expect(found.valueCount, `values drawn for ${valueSelector}`).toBeGreaterThan(0);
  expect(found.rows, "rows at least 48 px, padded no more than SettingRow").toEqual([]);
  expect(found.values, "trailing values in the prose token").toEqual([]);
}

const settingsView = (page: Page) => page.getByRole("dialog", { name: "Settings" });

async function openSection(page: Page, width: number, section: string): Promise<Locator> {
  await page.goto("/settings");
  const settings = settingsView(page);
  await settings
    .getByRole(width === 390 ? "tab" : "button", { name: section, exact: true })
    .first()
    .click();
  return settings;
}

for (const width of [390, 1440] as const) {
  test.describe(`${width}`, () => {
    const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
    test.use(width === 390 ? phone : { viewport: { width: 1440, height: 900 } });

    test("Settings > Keyboard link rows and their values keep the roles", async ({ page }) => {
      const settings = await openSection(page, width, "Keyboard");
      await expectRoles(settings, "[data-list-row]", "[data-row-value]");
    });

    test("Settings > Keyboard's edited lists keep the row role", async ({ page }) => {
      const settings = await openSection(page, width, "Keyboard");
      await settings.getByRole("button", { name: "Edit", exact: true }).click();
      await expect(settings.locator("[data-edit-key]").first()).toBeVisible();
      await expectRoles(settings, "[data-edit-key], [data-restore-key]", null);
    });

    test("the Packs sheet keeps the row and value roles", async ({ page }) => {
      const settings = await openSection(page, width, "Keyboard");
      await settings.getByRole("button", { name: /^Packs/ }).click();
      const sheet = page.getByRole("dialog", { name: "Packs" });
      await expect(sheet.locator("[data-pack-row]").first()).toBeVisible();
      await expectRoles(sheet, "[data-pack-row]", "[data-row-value]");
    });

    test("search hits keep the row and value roles", async ({ page }) => {
      await page.goto("/settings");
      const settings = settingsView(page);
      const field = settings.getByRole("searchbox");
      await field.first().fill("theme");
      const hits = settings.locator("[data-setting-hits]");
      await expect(hits.locator("[data-list-row]").first()).toBeVisible();
      await expectRoles(hits, "[data-list-row]", "[data-row-value]");
    });

    // The fixture's mesh documents hold an open join and an expired one; approving the open one draws the answered
    // state, which replaces the buttons and must keep their height. The approval is written to the core's document, so
    // the fixture is put back afterwards for every later spec.
    test("Settings > Machines join answers reserve the control height and use the value role", async ({ page }) => {
      test.setTimeout(REDIAL_BOUND_MS + 60_000);
      resetMeshDocs();
      try {
        await expect.poll(machineState, { timeout: REDIAL_BOUND_MS }).toBe("connected");
        const settings = await openSection(page, width, "Machines");
        const open = settings.locator('[data-mesh-answer="open"]');
        await expect(open).toBeVisible({ timeout: 20_000 });
        const control = await open.evaluate(() => {
          const probe = document.createElement("div");
          probe.style.height = "var(--control)";
          document.body.append(probe);
          const height = probe.getBoundingClientRect().height;
          probe.remove();
          return height;
        });
        const buttons = await open
          .locator("button")
          .evaluateAll((all) => all.map((b) => b.getBoundingClientRect().height));
        expect(buttons.length, "the open join's answers").toBeGreaterThan(0);
        for (const height of buttons) expect(height).toBe(control);
        await expectRoles(settings, "[data-mesh-group] [data-setting-row]", "[data-mesh-answer][data-row-value]");

        await open.locator('[data-mesh-verdict="approve"]').click();
        // The fixture's join is not one the e2e host holds, so the host answers that it is gone (#2936).
        const answered = settings.locator('[data-mesh-answer="gone"]');
        await expect(answered).toBeVisible({ timeout: 15_000 });
        const box = await answered.boundingBox();
        expect(
          box?.height ?? 0,
          "the answered state keeps the height of the buttons it replaced",
        ).toBeGreaterThanOrEqual(control);
        await expectRoles(settings, '[data-mesh-group="pending"] [data-setting-row]', '[data-mesh-answer="gone"]');
      } finally {
        resetMeshDocs();
      }
    });
  });
}

test.describe("390 phone toolbar", () => {
  const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
  test.use(phone);

  for (const section of ["Terminal", "Keybindings"] as const) {
    test(`Settings > ${section}: Tab walks the toolbar in the order it is drawn`, async ({ page }) => {
      const settings = await openSection(page, 390, section);
      const field = settings.locator('[data-slot="settings-body"] input[type=search]');
      await expect(field).toBeVisible();
      // Every control, disabled ones too (Reset all is disabled until something changed): DOM order is drawn order.
      const order = await field.evaluate((input) => {
        const bar = input.parentElement?.parentElement;
        const controls = [...(bar?.querySelectorAll<HTMLElement>("input, button") ?? [])].map((control) => ({
          box: control.getBoundingClientRect(),
          name: control.id || control.textContent?.trim() || "",
          enabled: !control.matches(":disabled"),
        }));
        const byLine = controls.toSorted(
          (a, b) => Math.round(a.box.top) - Math.round(b.box.top) || a.box.left - b.box.left,
        );
        return {
          dom: controls.map((control) => control.name),
          drawn: byLine.map((control) => control.name),
          focusable: byLine.filter((control) => control.enabled).map((control) => control.name),
        };
      });
      expect(order.dom, "the toolbar's DOM order").toEqual(order.drawn);
      const drawn = order.focusable;
      expect(drawn.length, "enabled toolbar controls").toBeGreaterThan(1);
      await field.focus();
      const walked: string[] = [];
      for (let step = 0; step < drawn.length; step += 1) {
        // oxlint-disable-next-line no-await-in-loop -- each Tab moves from where the last one left focus
        if (step > 0) await page.keyboard.press("Tab");
        walked.push(
          // oxlint-disable-next-line no-await-in-loop -- read after this step's Tab, before the next
          await page.evaluate(() => document.activeElement?.id || document.activeElement?.textContent?.trim() || ""),
        );
      }
      expect(walked).toEqual(drawn);
    });
  }
});
