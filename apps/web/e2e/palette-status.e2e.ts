import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { seedSpaces } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { endOwnTerminals } from "./own-terminals.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

endOwnTerminals();

const SPACE = "pal1454";
const dialog = (page: Page) => page.getByRole("dialog", { name: "Command palette" });
const states = (page: Page) => dialog(page).getByRole("group", { name: "Show agents" });
const option = (page: Page, name: string) => dialog(page).getByRole("option").filter({ hasText: name });

function startShell(name: string): string {
  const out = hcOn("host", ["run", "--bg", "--name", name, "--label", `space=${SPACE}`, "--", "env", "PS1=$ ", "sh"]);
  const started: unknown = JSON.parse(out);
  if (typeof started !== "object" || started === null || !("address" in started)) throw new Error(out);
  return String(started.address);
}

/** hc refuses to type into a blocked terminal unless forced. */
function report(address: string, state: string): void {
  hcOn("host", ["send", "--force", address, `printf '\\033]7501;state=${state}\\033\\\\'`]);
}

async function openPalette(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+Shift+KeyP");
  await expect(dialog(page)).toBeVisible();
}

test("the palette filters its agents by state, and draws no filter while they share one state", async ({ page }) => {
  const asks = startShell("pal-asks");
  const calm = startShell("pal-calm");
  seedSpaces([
    {
      folder: "",
      id: "spc-pal1454",
      name: SPACE,
      tabs: [
        { id: "tb-pal-asks", name: "asks", terminal: asks },
        { id: "tb-pal-calm", name: "calm", terminal: calm },
      ],
    },
  ]);
  await page.goto("/");
  await expect(page.getByRole("tablist", { name: "Tabs" }).getByRole("tab")).toHaveCount(2, { timeout: 20_000 });

  await openPalette(page);
  await expect(option(page, "pal-asks")).toBeVisible();
  await expect(states(page)).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(dialog(page).getByRole("combobox", { name: "Command" })).toBeFocused();
  await page.keyboard.press("Escape");

  report(asks, "blocked");
  await expect(page.getByRole("contentinfo")).toContainText("needs you", { timeout: 15_000 });
  await openPalette(page);
  const needsYou = states(page).getByRole("button", { name: /^Needs you \d+$/ });
  await expect(needsYou).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(states(page).getByRole("button").first()).toBeFocused();
  await needsYou.click();
  await expect(option(page, "pal-asks")).toBeVisible();
  await expect(option(page, "pal-calm")).toHaveCount(0);
  await expect(dialog(page).getByRole("group", { name: "Actions" })).toHaveCount(0);

  await states(page)
    .getByRole("button", { name: /^All \d+$/ })
    .click();
  await expect(option(page, "pal-calm")).toBeVisible();
  await expect(dialog(page).getByRole("group", { name: "Actions" })).toBeVisible();

  // The narrowest phone holds the whole row: every segment sits inside the dialog, none scrolled away. 320 rather than
  // 390, so the fit keeps slack for wider fonts than this machine's (CI's Linux fonts are).
  await page.setViewportSize({ width: 320, height: 640 });
  const frame = await dialog(page).boundingBox();
  const segments = await states(page)
    .getByRole("button")
    .evaluateAll((buttons) =>
      buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return { left: box.left, right: box.right };
      }),
    );
  expect(frame).not.toBeNull();
  for (const box of segments) {
    expect(box.left).toBeGreaterThanOrEqual(frame?.x ?? 0);
    expect(box.right).toBeLessThanOrEqual((frame?.x ?? 0) + (frame?.width ?? 0));
  }
  await page.keyboard.press("Escape");
  report(asks, "working");
});
